/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { AIProvider, ChatMessage, ToolCall } from '../providers/AIProvider';
import { AIToolExecutor, ToolContext, isDestructiveToolCall, TOOL_DEFINITIONS } from '../tools/AITools';
import { config } from '../config';
import * as chatState from '../db/ChatStateStore';
import { listRecentNotes } from '../db/NotesStore';
import type { Logger } from '../logger';

export interface LoopCallbacks {
  /** Send/edit a progress message (throttled by the gateway). */
  sendProgress: (text: string) => Promise<void>;
  /** Ask user to approve a destructive action. true = approved. */
  requestApproval: (description: string) => Promise<boolean>;
  /** Progress from long-running tools (Claude Code bridge). */
  onToolProgress?: (text: string) => void;
}

export interface LoopResult {
  response: string;
  /** True when the loop hit the iteration cap and awaits continue/stop. */
  awaitingContinuation: boolean;
}

const SYSTEM_PROMPT = `You are AiWindowsAssistant, an AI agent running on the user's Windows 11 PC, controlled via Telegram. You emulate how Claude Code works: the user delegates tasks to you and you complete them fully using your tools.

Environment:
- OS: Windows 11. Shell for execute_command is PowerShell (use PowerShell syntax, NOT bash).
- Default working directory: ${config.assistant.defaultCwd}
- Claude Code workspace: ${config.claude.workspace}

Rules:
- Complete tasks fully and verify results. Never just narrate what you would do — call the next required tool.
- After a failure, retry with a reasonable alternative before giving up.
- For non-trivial coding tasks (editing code, refactoring, debugging, multi-file changes, running builds/tests), delegate to the delegate_to_claude_code tool — it runs Claude Code (the same engine as the VS Code Claude Code tab) with full agentic capability in the workspace.
- Use execute_command for quick local operations: system checks, git status, listing processes, quick one-liners.
- Prefer the curated sysadmin tools (get_disk_usage, list_processes, list_services, get_event_log_errors, get_network_info, firewall_rule_status, list_scheduled_tasks, get_installed_software, get_startup_programs) over raw PowerShell when one fits — they return structured, reliable output.
- Use save_note to remember durable facts worth recalling in future conversations (infrastructure details, preferences, recurring patterns) — not transient task details.
- Destructive operations will be shown to the user for approval before executing.
- Keep replies concise — they are read on a phone. Use short bullet points. Plain text or simple Markdown (Telegram).
- Treat each user request as an independent task unless it clearly continues the current one.
- When the task is complete, summarize what was done and ask what the user wants to delegate next.`;

export class AgentLoop {
  /** In-memory cache of persisted history, hydrated from ChatStateStore on first access per chat
   * per process lifetime — avoids a DB round-trip on every loop iteration while remaining correct
   * across app restarts (a fresh process has an empty cache and re-hydrates from SQLite). */
  private histories = new Map<number, ChatMessage[]>();

  constructor(
    private provider: AIProvider,
    private executor: AIToolExecutor,
    private logger?: Logger
  ) {}

  getHistory(chatId: number): ChatMessage[] {
    let h = this.histories.get(chatId);
    if (!h) {
      h = chatState.loadHistory(chatId);
      this.histories.set(chatId, h);
    }
    return h;
  }

  clear(chatId: number): void {
    this.histories.delete(chatId);
    chatState.clearHistory(chatId);
    chatState.setParked(chatId, false);
  }

  isParked(chatId: number): boolean {
    return chatState.isParked(chatId);
  }

  unpark(chatId: number): void {
    chatState.setParked(chatId, false);
  }

  /** Appends to the in-memory array and persists in the same call — every mutation to a chat's
   * history in run() goes through here so nothing survives only in memory. */
  private pushMessage(chatId: number, history: ChatMessage[], message: ChatMessage): void {
    history.push(message);
    chatState.appendHistoryMessage(chatId, message);
  }

  async run(chatId: number, userText: string, ctx: Omit<ToolContext, 'requestApproval'>, cb: LoopCallbacks): Promise<LoopResult> {
    const pendingId = chatState.startPendingTask(chatId, userText);
    try {
      return await this.runInner(chatId, userText, ctx, cb, pendingId);
    } catch (err) {
      chatState.finishPendingTask(pendingId, 'failed');
      throw err;
    }
  }

  private async runInner(
    chatId: number,
    userText: string,
    ctx: Omit<ToolContext, 'requestApproval'>,
    cb: LoopCallbacks,
    pendingId: number
  ): Promise<LoopResult> {
    const history = this.getHistory(chatId);
    this.pushMessage(chatId, history, { role: 'user', content: userText });

    const maxIter = config.assistant.maxIterations;
    let finalText = '';

    for (let iter = 0; iter < maxIter; iter++) {
      await this.maybeSummarize(chatId, history);

      const messages: ChatMessage[] = [{ role: 'system', content: this.buildSystemPrompt() }, ...history];
      const resp = await this.provider.chatCompletion(messages, TOOL_DEFINITIONS);

      let toolCalls = resp.toolCalls;
      if (toolCalls.length === 0 && resp.content) {
        // Recover model-generated textual tool calls (port of AiAgentAssistant's recovery)
        toolCalls = this.recoverTextToolCalls(resp.content);
      }

      if (toolCalls.length === 0) {
        finalText = resp.content || '(empty response)';
        this.pushMessage(chatId, history, { role: 'assistant', content: finalText });
        chatState.setParked(chatId, false);
        chatState.finishPendingTask(pendingId, 'done');
        return { response: finalText, awaitingContinuation: false };
      }

      this.pushMessage(chatId, history, { role: 'assistant', content: resp.content || '', tool_calls: toolCalls });

      for (const tc of toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.arguments || '{}');
        } catch {
          /* keep {} */
        }

        // Destructive approval gate (same flow as AiAgentAssistant)
        if (isDestructiveToolCall(tc.name, parsedArgs)) {
          const desc = this.describeToolCall(tc.name, parsedArgs);
          const approved = await cb.requestApproval(desc);
          if (!approved) {
            this.pushMessage(chatId, history, {
              role: 'tool',
              tool_call_id: tc.id,
              name: tc.name,
              content: JSON.stringify({ success: false, error: 'Denied by user' }),
            });
            continue;
          }
        }

        await cb.sendProgress(`⚙️ ${this.describeToolCall(tc.name, parsedArgs)}`);
        const result = await this.executor.execute(tc.name, tc.arguments, {
          chatId,
          claudeBridge: ctx.claudeBridge,
          requestApproval: cb.requestApproval,
          onProgress: cb.onToolProgress,
        });
        this.pushMessage(chatId, history, {
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.name,
          content: this.truncateToolResult(result),
        });
      }
    }

    // Iteration cap reached — park and ask (AiAgentAssistant: reply continue/stop)
    chatState.setParked(chatId, true);
    const msg =
      `⚠️ Reached the iteration limit (${maxIter}). ` +
      `Reply *continue* to keep going or *stop* to end this task.`;
    this.pushMessage(chatId, history, { role: 'assistant', content: msg });
    chatState.finishPendingTask(pendingId, 'done');
    return { response: msg, awaitingContinuation: true };
  }

  /** System prompt plus a short digest of recent notes — the local-model engine's equivalent of
   * Claude Code's own MEMORY.md continuity (which this engine doesn't have access to). */
  private buildSystemPrompt(): string {
    const notes = listRecentNotes(15);
    if (notes.length === 0) return SYSTEM_PROMPT;
    const digest = notes.map((n) => `- ${n.summary}${n.tags ? ` [${n.tags}]` : ''}`).join('\n');
    return `${SYSTEM_PROMPT}\n\nThings you've learned and saved in past conversations (save_note):\n${digest}`;
  }

  private describeToolCall(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case 'execute_command':
        return `Run: ${String(args.command || '').slice(0, 120)}`;
      case 'launch_program':
        return `Launch: ${args.target}`;
      case 'search_files':
        return `Search in ${args.directory}`;
      case 'read_file':
        return `Read: ${args.path}`;
      case 'write_file':
        return `Write: ${args.path}`;
      case 'delete_file':
        return `🗑 Delete: ${args.path}`;
      case 'stop_process':
        return `⛔ Stop process: ${args.nameOrPid}`;
      case 'get_system_info':
        return 'Get system info';
      case 'delegate_to_claude_code':
        return `🤖 Delegate to Claude Code: ${String(args.prompt || '').slice(0, 120)}`;
      case 'service_control':
        return `⚙️ ${args.action} service: ${args.name}`;
      case 'firewall_rule_manage':
        return `🛡️ ${args.action} firewall rule: ${args.ruleName}`;
      case 'send_email':
        return `✉️ Email to ${args.to}: ${String(args.subject || '').slice(0, 80)}`;
      case 'generate_pdf':
        return `📄 Generate PDF: ${args.title}`;
      default:
        return `${name}(${JSON.stringify(args).slice(0, 100)})`;
    }
  }

  private truncateToolResult(result: unknown): string {
    let json = JSON.stringify(result);
    if (json.length > 1600) json = json.slice(0, 1600) + '…[truncated]';
    return json;
  }

  private estimateTokens(messages: ChatMessage[]): number {
    let chars = 0;
    for (const m of messages) chars += (m.content || '').length + (m.tool_calls ? 100 : 0);
    return Math.ceil(chars / 4);
  }

  private async maybeSummarize(chatId: number, history: ChatMessage[]): Promise<void> {
    if (this.estimateTokens(history) < config.assistant.summarizeThresholdTokens) return;
    const keep = config.assistant.historyKeepMessages;
    if (history.length <= keep + 2) return;
    const toSummarize = history.slice(0, history.length - keep);
    try {
      const summaryResp = await this.provider.chatCompletion([
        {
          role: 'user',
          content:
            'Summarize this conversation history in under 400 words, preserving key facts, decisions, file paths, and task state:\n\n' +
            toSummarize.map((m) => `${m.role}: ${(m.content || '').slice(0, 500)}`).join('\n'),
        },
      ]);
      const rest = history.slice(history.length - keep);
      history.length = 0;
      history.push({ role: 'user', content: `[Conversation summary so far]\n${summaryResp.content}` });
      history.push(...rest);
      chatState.replaceHistory(chatId, history);
      this.logger?.info({ summarized: toSummarize.length }, 'history summarized');
    } catch (err) {
      this.logger?.warn({ err }, 'summarization failed — truncating oldest messages instead');
      history.splice(0, history.length - keep);
      chatState.replaceHistory(chatId, history);
    }
  }

  /** Recover textual tool calls like `tool_name({...})` or {"function_call": {...}} — port of the original recovery logic. */
  private recoverTextToolCalls(content: string): ToolCall[] {
    const toolNames = TOOL_DEFINITIONS.map((t) => t.name);

    // JSON function_call / tool_use wrapper
    const jsonMatch = content.match(/\{\s*"(?:function_call|tool_use)"\s*:\s*(\{[\s\S]*?\})\s*\}/);
    if (jsonMatch) {
      try {
        const inner = JSON.parse(jsonMatch[1]);
        const name = inner.name || inner.function;
        if (toolNames.includes(name)) {
          return [
            {
              id: `recovered_${Date.now()}`,
              name,
              arguments: JSON.stringify(inner.arguments || inner.parameters || inner.input || {}),
            },
          ];
        }
      } catch {
        /* fall through */
      }
    }

    // tool_name({...})
    for (const name of toolNames) {
      const re = new RegExp(`${name}\\s*\\((\\{[\\s\\S]*?\\})\\)`, 'm');
      const m = content.match(re);
      if (m) {
        try {
          JSON.parse(m[1]); // validate
          return [{ id: `recovered_${Date.now()}`, name, arguments: m[1] }];
        } catch {
          /* invalid json */
        }
      }
    }
    return [];
  }
}
