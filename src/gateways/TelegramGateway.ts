/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { Telegraf, Context } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { config } from '../config';
import { AIProvider } from '../providers/AIProvider';
import { AIToolExecutor } from '../tools/AITools';
import { gateToolCall, grant } from '../security/Gate';
import { MCP_TOOL_NAMES } from '../mcp/McpServer';
import { listRoutines } from '../services/RepairService';
import { getEngine, setEngine, parseEngine, engineLabel } from '../services/EngineSettings';
import type { WebChat } from './WebChat';
import type { AlertService } from '../services/AlertService';
import { ClaudeCodeBridge } from '../tools/ClaudeCodeBridge';
import { AgentLoop } from '../core/AgentLoop';
import { RequestAnalyzer } from '../core/RequestAnalyzer';
import { Orchestrator } from '../core/Orchestrator';
import { getUsageSummary } from '../utils/tokenUsage';
import { isAutostartEnabled } from '../utils/autostart';
import * as chatState from '../db/ChatStateStore';
import { saveNote, listRecentNotes, searchNotes } from '../db/NotesStore';
import { createScheduledTask, listScheduledTasks, deleteScheduledTask, getScheduledTask } from '../db/ScheduleStore';
import { parseScheduleDesc, registerWindowsTask, unregisterWindowsTask } from '../services/SchedulerService';
import { runDoctor } from '../services/DoctorService';
import { ToastService } from '../services/ToastService';
import { HEALTH_PROMPT } from '../services/HealthCheckService';
import { helperState, HELPER_MISSING } from '../elevated/client';
import { ELEVATED_OPS } from '../elevated/ops';
import type { ApprovalHookServer } from '../tools/ApprovalHookServer';
import type { Logger } from '../logger';

/** Splits off the first N whitespace-separated tokens, preserving the untouched remainder
 * (needed for /schedule add, whose trailing prompt argument is free text). */
function splitTokens(s: string, n: number): { tokens: string[]; rest: string } {
  const re = /\S+/g;
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while (tokens.length < n && (m = re.exec(s))) {
    tokens.push(m[0]);
    lastEnd = re.lastIndex;
  }
  return { tokens, rest: s.slice(lastEnd).trim() };
}

interface PendingApproval {
  chatId: number;
  description: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  /** Random per approval: what a Windows notification's Approve/Deny button carries. */
  nonce: string;
  /** The Telegram prompt, edited when the answer comes from the PC instead. */
  messageId?: number;
  /** Offered as "Approve all here for 10 min" (Gate.ts). */
  grantKey?: string;
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes, same as AiAgentAssistant
const TG_LIMIT = 4096;

const HELP_TEXT = `*AiWindowsAssistant* — delegate tasks from your phone 🤖

/task <text> — Delegate a task (uses the default engine — see /engine)
/claude <prompt> — Send straight to Claude Code (no history, session resumes per chat)
/execute <cmd> — Run a PowerShell command
/ai <text> — Force this one request through the local model, regardless of default engine
/engine [claude|assistant] — Show/switch the engine for your messages: Claude Code (default) or the assistant engine (AI_PROVIDER, e.g. Ollama Cloud)
/workers [claude|assistant] — Same for BJavaDecompiler delegations and Fleet Guardian escalations
/provider [anthropic|ollama-cloud|ollama] — Show/switch AI provider (used by the local-model engine)
/aimodel [model] — Show/change model
/status — Bot, provider, Claude CLI, queue status
/doctor — Check everything works: settings, secrets, Claude Code, approval gate, AI, email, database

*Windows*
/screenshot — Screenshot of the PC (or send a photo of an error and ask about it)
/settings <page> — Open a Settings page (bluetooth, display, windows update…)
/cleanup — What can be cleaned, then /cleanup run all-safe (or a list of targets) to free space
/health — PC health report (PDF); /health weekly on|off — every week, automatically
/apps — Apps with updates; /apps search|install|upgrade <app>, /apps upgrade all
/admin — Administrator jobs (Windows updates, BitLocker, restore point, services…)
/fix — Repair routines: internet, printer, sound, search, windows-update, system-files, free-space, slow-pc
/alerts — Proactive alerts (disk full, threats, crashes, new startup programs…); on|off|check|reset

At the PC: Ctrl+Alt+Space opens a chat window with this same conversation.
/clear — Reset conversation + Claude Code session
/cancel — Cancel the running task
/pause, /resume — Pause/resume the bot
/remember <fact> — Save a durable note (both engines see it)
/notes [search] — List/search saved notes
/schedule add <name> <daily HH:mm|weekly <day> HH:mm|hourly> <prompt> — Recurring task (real Windows Task Scheduler, runs even if this app isn't open — always unattended, destructive actions are skipped)
/schedule list — List your scheduled tasks
/schedule remove <id> — Remove one
/help — This list

Or just type naturally — fast local actions run instantly (e.g. "open notepad", "system info"), anything else is delegated to Claude Code.`;

export class TelegramGateway {
  private bot: Telegraf;
  private provider: AIProvider;
  private executor = new AIToolExecutor();
  private loop: AgentLoop;
  private analyzer = new RequestAnalyzer();
  private claudeBridge: ClaudeCodeBridge;
  private orchestrator: Orchestrator;
  private logger?: Logger;

  private pendingApprovals = new Map<string, PendingApproval>();
  private progressMsgId = new Map<number, number>();
  private lastProgressEdit = new Map<number, number>();
  private startedAt = Date.now();
  private botUsername = '';
  /** Which engine handles plain text / /task by default — switchable via /engine. */
  private defaultEngine: 'claude' | 'ollama' = getEngine('tasks') === 'claude' ? 'claude' : 'ollama';

  private approvalServer: ApprovalHookServer | null = null;
  /** Windows notifications: approvals with Approve/Deny at the PC, long-task completions. */
  readonly toast: ToastService;

  paused = false;
  /** Tray menu hook — called whenever pause state changes. */
  onPauseChanged?: (paused: boolean) => void;

  constructor(claudeBridge: ClaudeCodeBridge, orchestrator: Orchestrator, logger?: Logger) {
    this.bot = new Telegraf(config.telegram.token, { handlerTimeout: 1_200_000 });
    // everything the bot says to the owner also appears in the chat window at the PC (WebChat)
    const tg = this.bot.telegram as unknown as { callApi: (m: string, p: Record<string, unknown>, o?: unknown) => Promise<unknown> };
    const callApi = tg.callApi.bind(tg);
    tg.callApi = async (method, payload, opts) => {
      const res = await callApi(method, payload, opts);
      try {
        this.mirror(method, payload || {}, res as { message_id?: number });
      } catch {
        /* the window is a convenience; never break Telegram for it */
      }
      return res;
    };
    this.provider = new AIProvider(logger);
    this.loop = new AgentLoop(this.provider, this.executor, logger);
    this.claudeBridge = claudeBridge;
    this.orchestrator = orchestrator;
    this.logger = logger;

    this.toast = new ToastService(logger);
    this.toast.register();

    this.setupMiddleware();
    this.setupCommands();
    this.setupHandlers();
  }

  /** index.ts: lets /doctor test the approval gate it started. */
  setApprovalServer(server: ApprovalHookServer): void {
    this.approvalServer = server;
    server.onToastAction = this.handleToastAction;
    // Claude Code's MCP tool calls (src/mcp/McpServer.ts): same gate, same approvals, files to this chat
    server.toolRunner = async (chatId, name, args) => {
      if (!this.isAllowed(chatId) || !MCP_TOOL_NAMES.has(name)) return { success: false, error: `tool ${name} is not available` };
      const gate = await gateToolCall(chatId, name, args, `🤖 Claude Code → ${name} ${JSON.stringify(args).slice(0, 200)}`, (d, key) => this.requestApproval(chatId, d, key));
      if (!gate.ok) return { success: false, error: gate.error };
      return this.executor.execute(name, JSON.stringify(args), {
        chatId,
        claudeBridge: this.claudeBridge,
        requestApproval: (d, key) => this.requestApproval(chatId, d, key),
        sendFile: (f, kind, caption) => this.sendFile(chatId, f, kind, caption),
      });
    };
  }

  // ---------- setup ----------

  private isAllowed(chatId: number): boolean {
    // Fail closed: an empty/misconfigured allowlist must never mean "allow everyone".
    // /start remains reachable regardless (see setupMiddleware) so first-run setup
    // can still discover the chat ID to put in TELEGRAM_ALLOWED_USERS.
    return config.telegram.allowedUsers.includes(chatId);
  }

  private setupMiddleware(): void {
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (!this.isAllowed(chatId)) {
        // Only answer /start so the owner can discover their chat ID
        const text = (ctx.message as { text?: string } | undefined)?.text || '';
        if (text.startsWith('/start')) return next();
        await ctx.reply(`⛔ Unauthorized. Your chat ID is: ${chatId}`);
        this.logger?.warn({ chatId }, 'unauthorized access attempt');
        return;
      }
      return next();
    });
  }

  private setupCommands(): void {
    this.bot.start(async (ctx) => {
      const allowed = this.isAllowed(ctx.chat.id);
      await ctx.reply(
        `👋 *AiWindowsAssistant* online.\n\n` +
          `Your chat ID: \`${ctx.chat.id}\`${!allowed ? '\n\n⚠️ Add this ID to TELEGRAM_ALLOWED_USERS in .env and restart.' : ''}\n\n` +
          `What task would you like to delegate?`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('help', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' }));

    this.bot.command('status', async (ctx) => {
      const uptime = ((Date.now() - this.startedAt) / 60000).toFixed(0);
      const usage = getUsageSummary();
      const claudePath = this.claudeBridge.resolveCliPath();
      const apiKeyLeak = process.env.ANTHROPIC_API_KEY
        ? '\n• ⚠️ ANTHROPIC_API_KEY is set in this app\'s env — stripped before every Claude Code spawn so it always uses your subscription login, not this key.'
        : '';
      await ctx.reply(
        `📊 *Status*\n` +
          `• Bot: @${this.botUsername} ${this.paused ? '(⏸ paused)' : ''}\n` +
          `• Default engine: ${this.defaultEngine} (plain text + /task)\n` +
          `• Local model: ${this.provider.getInfo()}\n` +
          `• Claude Code CLI: ${claudePath ? '✅ ' + claudePath : '❌ not found'}\n` +
          `• Claude session (this chat): ${this.claudeBridge.hasSession(ctx.chat.id) ? 'active' : 'none'}\n` +
          `• Queue: ${this.orchestrator.getActiveCount()} active, ${this.orchestrator.getQueuedCount()} queued\n` +
          `• Uptime: ${uptime} min\n` +
          `• Tokens logged: ${usage.total.toLocaleString()} (${usage.entries} calls)\n` +
          `• Autostart: ${isAutostartEnabled() ? 'enabled' : 'disabled'}${apiKeyLeak}`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('doctor', async (ctx) => {
      await ctx.reply('🩺 Checking…');
      await this.sendLong(ctx.chat.id, await runDoctor(this.claudeBridge, this.approvalServer, this.provider.getProvider()));
    });

    this.bot.command('task', (ctx) => this.handleDelegatedText(ctx, this.commandArgs(ctx), { skipFastPath: true }));
    this.bot.command('ai', (ctx) => this.handleDelegatedText(ctx, this.commandArgs(ctx), { skipFastPath: true, forceEngine: 'ollama' }));

    this.bot.command('engine', async (ctx) => {
      const arg = this.commandArgs(ctx).toLowerCase();
      if (!arg) {
        return ctx.reply(
          `Your messages and /task run on: ${engineLabel(getEngine('tasks'))}\n` +
            `BJavaDecompiler / Fleet Guardian work runs on: ${engineLabel(getEngine('workers'))}\n\n` +
            '/engine claude | assistant — your messages\n/workers claude | assistant — delegated work\n' +
            '(assistant = this app\'s own engine with AI_PROVIDER, e.g. Ollama Cloud; claude = Claude Code, the default)'
        );
      }
      const e = parseEngine(arg, getEngine('tasks'));
      if (!['claude', 'claude-code', 'assistant', 'ollama', 'ollama-cloud', 'local'].includes(arg)) return ctx.reply('Usage: /engine claude | assistant');
      setEngine('tasks', e);
      this.defaultEngine = e === 'claude' ? 'claude' : 'ollama';
      await ctx.reply(`✅ Your messages and /task now run on ${engineLabel(e)}. (Kept after restarts.)`);
    });

    this.bot.command('workers', async (ctx) => {
      const arg = this.commandArgs(ctx).toLowerCase();
      if (!['claude', 'claude-code', 'assistant', 'ollama', 'ollama-cloud', 'local'].includes(arg)) {
        return ctx.reply(`BJavaDecompiler / Fleet Guardian work runs on: ${engineLabel(getEngine('workers'))}\nUsage: /workers claude | assistant`);
      }
      const e = parseEngine(arg, getEngine('workers'));
      setEngine('workers', e);
      await ctx.reply(`✅ BJavaDecompiler delegations and Fleet Guardian escalations now run on ${engineLabel(e)}. (Kept after restarts.)`);
    });

    this.bot.command('claude', async (ctx) => {
      const prompt = this.commandArgs(ctx);
      if (!prompt) return ctx.reply('Usage: /claude <prompt for Claude Code>');
      void this.orchestrator.submit(ctx.chat.id, () => this.runClaudeTask(ctx.chat.id, prompt));
    });

    // ---------- Windows 11 (1.4.0) — all through runToolDirect, so the policy + approval apply ----------
    const tool = (ctx: Context, name: string, args: Record<string, unknown>, description: string) =>
      void this.orchestrator.submit(ctx.chat!.id, () => this.runToolDirect(ctx.chat!.id, name, args, description));

    this.bot.command('screenshot', (ctx) => tool(ctx, 'take_screenshot', {}, 'Screenshot'));

    this.bot.command('settings', (ctx) => {
      const page = this.commandArgs(ctx) || 'settings';
      tool(ctx, 'open_settings', { page }, `Open Settings → ${page}`);
    });

    this.bot.command('cleanup', (ctx) => {
      const m = /^run\s+(.+)$/i.exec(this.commandArgs(ctx));
      if (m) tool(ctx, 'clean_up_disk', { targets: m[1] }, `Clean up: ${m[1]}`);
      else tool(ctx, 'analyze_disk_space', {}, 'What can be cleaned');
    });

    this.bot.command('health', async (ctx) => {
      const arg = this.commandArgs(ctx);
      const weekly = /^weekly(?:\s+(on|off))?(?:\s+([a-z]{3})\s+(\d\d:\d\d))?$/i.exec(arg);
      if (!weekly) return tool(ctx, 'health_report', {}, 'Health report');
      const existing = listScheduledTasks(ctx.chat.id).filter((t) => t.prompt === HEALTH_PROMPT);
      if ((weekly[1] || 'on').toLowerCase() === 'off') {
        for (const t of existing) {
          unregisterWindowsTask(t.id);
          deleteScheduledTask(t.id);
        }
        return ctx.reply(existing.length ? '🗓 Weekly health report turned off.' : 'No weekly health report was scheduled.');
      }
      if (existing.length) return ctx.reply(`🗓 Already scheduled (${existing[0].scheduleDesc}). /health weekly off to stop it.`);
      const desc = `weekly ${(weekly[2] || 'MON').toUpperCase()} ${weekly[3] || '09:00'}`;
      const spec = parseScheduleDesc(desc);
      if (!spec) return ctx.reply('Usage: /health weekly on [MON 09:00] | /health weekly off');
      const id = createScheduledTask(ctx.chat.id, 'Weekly health report', desc, HEALTH_PROMPT, 'claude');
      try {
        registerWindowsTask(id, spec);
      } catch (err) {
        deleteScheduledTask(id);
        return ctx.reply(`❌ Could not create the Windows scheduled task: ${err instanceof Error ? err.message : String(err)}`);
      }
      return ctx.reply(`🗓 Weekly health report scheduled (${desc}). The PDF arrives here — read-only, no approvals needed.`);
    });

    this.bot.command('apps', (ctx) => {
      const arg = this.commandArgs(ctx);
      const m = /^(search|install|upgrade|update)\s+(.+)$/i.exec(arg);
      if (!m) return tool(ctx, 'apps_updates', {}, 'Apps with updates');
      const verb = m[1].toLowerCase();
      if (verb === 'search') return tool(ctx, 'apps_search', { query: m[2] }, `Search apps: ${m[2]}`);
      if (verb === 'install') return tool(ctx, 'apps_install', { app: m[2] }, `Install ${m[2]} (winget)`);
      return tool(ctx, 'apps_upgrade', { app: m[2] }, `Update ${m[2]} (winget)`);
    });

    this.bot.command('fix', (ctx) => {
      const name = this.commandArgs(ctx).toLowerCase();
      if (!name) return ctx.reply(`🛠 Repair routines — /fix <name>:\n${listRoutines()}\n\nYou approve each routine once; the ones that change the system take a restore point first.`);
      tool(ctx, 'run_repair', { routine: name }, `Repair: ${name}`);
    });

    this.bot.command('alerts', async (ctx) => {
      if (!this.alerts) return ctx.reply('Alerts are not running in this process.');
      const arg = this.commandArgs(ctx).toLowerCase();
      if (arg === 'off' || arg === 'on') {
        this.alerts.setEnabled(arg === 'on');
        return ctx.reply(arg === 'on' ? '🔔 Alerts on.' : '🔕 Alerts off.');
      }
      if (arg === 'reset') return ctx.reply(`🔔 New baseline: ${await this.alerts.reset()} startup programs, services and tasks count as known now.`);
      if (arg === 'check') {
        const sent = await this.alerts.check();
        return ctx.reply(sent.length ? `🔔 ${sent.length} alert(s) sent.` : '🔔 Checked — nothing new.');
      }
      return ctx.reply(this.alerts.status());
    });

    this.bot.command('admin', (ctx) => {
      const [task, ...rest] = this.commandArgs(ctx).split(/\s+/).filter(Boolean);
      if (!task) {
        const st = helperState();
        const state = st.running ? (st.admin ? '🟢 running as administrator' : '🔴 running WITHOUT administrator rights') : '⚪ not installed / not running';
        const list = Object.entries(ELEVATED_OPS).map(([k, v]) => `• ${k}${v.paramHelp ? ` <${v.paramHelp}>` : ''} — ${v.title}${v.risk === 'change' ? ' (asks first)' : ''}`);
        return ctx.reply(`🛡 Administrator helper: ${state}${st.outdated ? ' — outdated, re-run the install' : ''}\n\n/admin <task> [param]:\n${list.join('\n')}${st.running ? '' : `\n\n${HELPER_MISSING}`}`);
      }
      tool(ctx, 'admin_task', { task, param: rest.join(' ') }, `Admin: ${task}${rest.length ? ' ' + rest.join(' ') : ''}`);
    });

    this.bot.command('execute', async (ctx) => {
      const command = this.commandArgs(ctx);
      if (!command) return ctx.reply('Usage: /execute <powershell command>');
      await this.runToolDirect(ctx.chat.id, 'execute_command', { command }, `Run: ${command}`);
    });

    this.bot.command('provider', async (ctx) => {
      const arg = this.commandArgs(ctx).toLowerCase();
      if (!arg) return ctx.reply(`Current provider: ${this.provider.getInfo()}`);
      if (!['anthropic', 'ollama-cloud', 'ollama'].includes(arg)) {
        return ctx.reply('Unknown provider. Use: anthropic | ollama-cloud | ollama');
      }
      this.provider.setProvider(arg as 'anthropic' | 'ollama-cloud' | 'ollama');
      await ctx.reply(`✅ Provider switched to ${this.provider.getInfo()}`);
    });

    this.bot.command('aimodel', async (ctx) => {
      const arg = this.commandArgs(ctx);
      if (!arg) return ctx.reply(`Current model: ${this.provider.getModel()} (provider: ${this.provider.getProvider()})`);
      this.provider.setModel(arg);
      await ctx.reply(`✅ Model set to ${arg}`);
    });

    this.bot.command('clear', async (ctx) => {
      this.loop.clear(ctx.chat.id);
      this.claudeBridge.clearSession(ctx.chat.id);
      await ctx.reply('🧹 Conversation and Claude Code session cleared. What task would you like to delegate?');
    });

    this.bot.command('cancel', async (ctx) => {
      const killed = this.claudeBridge.cancel(ctx.chat.id);
      await ctx.reply(killed ? '🛑 Claude Code task cancelled.' : 'Nothing running for this chat.');
    });

    this.bot.command('pause', async (ctx) => {
      this.setPaused(true);
      await ctx.reply('⏸ Paused. I will ignore new messages until /resume.');
    });

    this.bot.command('resume', async (ctx) => {
      this.setPaused(false);
      await ctx.reply('▶️ Resumed. What task would you like to delegate?');
    });

    this.bot.command('remember', async (ctx) => {
      const text = this.commandArgs(ctx);
      if (!text) return ctx.reply('Usage: /remember <fact to save>');
      const id = saveNote(text, undefined, 'user');
      await ctx.reply(`✅ Saved note #${id}.`);
    });

    this.bot.command('notes', async (ctx) => {
      const q = this.commandArgs(ctx);
      const notes = q ? searchNotes(q) : listRecentNotes(20);
      if (notes.length === 0) return ctx.reply(q ? `No notes matching "${q}".` : 'No notes saved yet. Use /remember <fact> to add one.');
      const lines = notes.map((n) => `#${n.id} (${n.createdAt.slice(0, 10)}) ${n.summary}${n.tags ? ` [${n.tags}]` : ''}`);
      await this.sendLong(ctx.chat.id, lines.join('\n'));
    });

    this.bot.command('schedule', async (ctx) => this.handleSchedule(ctx));
  }

  private async handleSchedule(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const args = this.commandArgs(ctx);
    const { tokens: subTokens, rest: afterSub } = splitTokens(args, 1);
    const sub = (subTokens[0] || '').toLowerCase();

    if (sub === 'list') {
      const tasks = listScheduledTasks(chatId);
      if (tasks.length === 0) return void ctx.reply('No scheduled tasks. Add one: /schedule add <name> <daily HH:mm|weekly <day> HH:mm|hourly> <prompt>');
      const lines = tasks.map(
        (t) =>
          `#${t.id} "${t.name}" — ${t.scheduleDesc} (${t.engine})${t.enabled ? '' : ' [disabled]'}` +
          (t.lastRunAt ? `\n   last run: ${t.lastRunAt}` : '')
      );
      await this.sendLong(chatId, lines.join('\n\n'));
      return;
    }

    if (sub === 'remove') {
      const id = parseInt(afterSub, 10);
      if (!Number.isFinite(id)) return void ctx.reply('Usage: /schedule remove <id>');
      const task = getScheduledTask(id);
      if (!task || task.chatId !== chatId) return void ctx.reply('Task not found.');
      unregisterWindowsTask(id);
      deleteScheduledTask(id);
      await ctx.reply(`🗑 Removed scheduled task #${id} ("${task.name}").`);
      return;
    }

    if (sub === 'add') {
      const { tokens: nameTok, rest: afterName } = splitTokens(afterSub, 1);
      const name = nameTok[0];
      if (!name) {
        await ctx.reply('Usage: /schedule add <name> <daily HH:mm|weekly <day> HH:mm|hourly> <prompt>');
        return;
      }
      const kindMatch = afterName.match(/^(hourly|daily|weekly)\b\s*([\s\S]*)$/i);
      if (!kindMatch) {
        await ctx.reply('Schedule must start with hourly, daily HH:mm, or weekly <DAY> HH:mm — e.g. "daily 09:00".');
        return;
      }
      const kind = kindMatch[1].toLowerCase();
      let scheduleDesc: string;
      let prompt: string;
      if (kind === 'hourly') {
        scheduleDesc = 'hourly';
        prompt = kindMatch[2].trim();
      } else if (kind === 'daily') {
        const { tokens: t, rest } = splitTokens(kindMatch[2], 1);
        scheduleDesc = `daily ${t[0] || ''}`;
        prompt = rest;
      } else {
        const { tokens: t, rest } = splitTokens(kindMatch[2], 2);
        scheduleDesc = `weekly ${t[0] || ''} ${t[1] || ''}`;
        prompt = rest;
      }
      const spec = parseScheduleDesc(scheduleDesc);
      if (!spec) {
        await ctx.reply(`Invalid schedule "${scheduleDesc}". Examples: hourly | daily 09:00 | weekly MON 09:00`);
        return;
      }
      if (!prompt) {
        await ctx.reply('Missing the prompt to run — it comes after the schedule.');
        return;
      }
      const id = createScheduledTask(chatId, name, scheduleDesc, prompt, this.defaultEngine);
      try {
        registerWindowsTask(id, spec);
      } catch (err) {
        deleteScheduledTask(id);
        await ctx.reply(`❌ Failed to register with Windows Task Scheduler: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      await ctx.reply(
        `✅ Scheduled "${name}" (#${id}) — ${scheduleDesc}, engine: ${this.defaultEngine}.\n` +
          'Runs unattended (even if this app is closed) — destructive actions are automatically skipped, not approved.'
      );
      return;
    }

    await ctx.reply('Usage: /schedule add <name> <daily HH:mm|weekly <day> HH:mm|hourly> <prompt> | /schedule list | /schedule remove <id>');
  }

  private setupHandlers(): void {
    this.bot.on('callback_query', async (ctx) => {
      const data = (ctx.callbackQuery as { data?: string }).data || '';
      const answered = this.answerButton(data, 'Telegram');
      await ctx.answerCbQuery(answered === null ? 'Expired or already handled' : answered ? 'Approved' : 'Denied');
    });

    this.bot.on('photo', (ctx) => {
      const sizes = ctx.message.photo;
      return this.handlePhoto(ctx, sizes[sizes.length - 1].file_id, ctx.message.caption || '');
    });
    this.bot.on('document', (ctx) => {
      const d = ctx.message.document;
      if (!/^image\//.test(d.mime_type || '')) return ctx.reply('I can look at images (photos or image files). Other files are not supported yet.');
      return this.handlePhoto(ctx, d.file_id, ctx.message.caption || '');
    });

    this.bot.on('text', (ctx) => this.handleDelegatedText(ctx, ctx.message.text, { skipFastPath: false }));
  }

  // ---------- message flow ----------

  private commandArgs(ctx: Context): string {
    const text = (ctx.message as { text?: string } | undefined)?.text || '';
    return text.replace(/^\/\w+(@\w+)?\s*/, '').trim();
  }

  private handleDelegatedText(
    ctx: Context,
    text: string,
    opts: { skipFastPath: boolean; forceEngine?: 'claude' | 'ollama' }
  ): Promise<unknown> | void {
    if (!text) return ctx.reply('Please provide some text.');
    const chatId = ctx.chat!.id;

    if (this.paused) {
      return ctx.reply('⏸ Bot is paused. Use /resume to continue.');
    }

    let forceEngine = opts.forceEngine;

    // continue/stop for parked loops (iteration cap), same as AiAgentAssistant
    if (this.loop.isParked(chatId)) {
      const lower = text.toLowerCase().trim();
      if (lower === 'stop') {
        this.loop.clear(chatId);
        return ctx.reply('🛑 Task stopped. What would you like to delegate next?');
      }
      if (lower === 'continue') {
        this.loop.unpark(chatId);
        forceEngine = 'ollama'; // resume the same loop that was parked, regardless of the current default
      }
    }

    void this.orchestrator.submit(chatId, async () => {
      await this.sendTyping(chatId);
      try {
        // Local fast path (RequestAnalyzer) — no AI round-trip
        if (!opts.skipFastPath) {
          const intent = this.analyzer.analyze(text);
          if (intent) {
            await this.runToolDirect(chatId, intent.tool, intent.args, intent.description);
            return;
          }
        }

        const engine = forceEngine || this.defaultEngine;
        if (engine === 'claude') {
          await this.runClaudeTask(chatId, text);
          return;
        }

        // Local AgentLoop (Ollama/Anthropic provider, tool-calling loop)
        await this.sendProgress(chatId, '🧠 Thinking…');
        const started = Date.now();
        const result = await this.loop.run(
          chatId,
          text,
          {
            chatId,
            claudeBridge: this.claudeBridge,
            onProgress: (t) => void this.sendProgressThrottled(chatId, `🤖 Claude Code:\n${this.tail(t)}`),
            sendFile: (f, kind, caption) => this.sendFile(chatId, f, kind, caption),
          },
          {
            sendProgress: (t) => this.sendProgressThrottled(chatId, t),
            requestApproval: (desc, key) => this.requestApproval(chatId, desc, key),
            onToolProgress: (t) => void this.sendProgressThrottled(chatId, `🤖 Claude Code:\n${this.tail(t)}`),
          }
        );
        await this.clearProgress(chatId);
        await this.sendLong(chatId, result.response);
        this.toastIfLong(started, text, result.response);
      } catch (err) {
        await this.clearProgress(chatId);
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.error({ err }, 'task failed');
        await this.sendLong(chatId, `❌ Error: ${msg}`);
      }
    });
  }

  /** Direct single-tool execution (used by /execute and the local fast path). */
  private async runToolDirect(chatId: number, tool: string, args: Record<string, unknown>, description: string): Promise<void> {
    const pendingId = chatState.startPendingTask(chatId, description);
    let ok = false;
    try {
      const gate = await gateToolCall(chatId, tool, args, description, (d, key) => this.requestApproval(chatId, d, key));
      if (!gate.ok) {
        await this.bot.telegram.sendMessage(chatId, gate.blocked ? `⛔ ${gate.error}\n${description}` : '❌ Denied.');
        return;
      }
      await this.sendTyping(chatId);
      const result = await this.executor.execute(tool, JSON.stringify(args), {
        chatId,
        claudeBridge: this.claudeBridge,
        requestApproval: (d) => this.requestApproval(chatId, d),
        onProgress: (t) => void this.sendProgressThrottled(chatId, `🤖 Claude Code:\n${this.tail(t)}`),
        sendFile: (f, kind, caption) => this.sendFile(chatId, f, kind, caption),
      });
      ok = result.success;
      const out = result.success
        ? `✅ ${description}\n${String(result.output ?? result.stdout ?? 'Done.')}`
        : `❌ ${description}\n${result.error || 'Failed'}${result.stderr ? '\n' + result.stderr : ''}`;
      await this.sendLong(chatId, out);
      await this.bot.telegram.sendMessage(chatId, 'What task would you like to delegate next?');
    } finally {
      chatState.finishPendingTask(pendingId, ok ? 'done' : 'failed');
    }
  }

  /**
   * Runs a prompt through Claude Code. Caller is responsible for orchestrator.submit()
   * — this must NOT submit itself, since handleDelegatedText's default engine path calls
   * this from inside an already-submitted callback (submitting again for the same chatId
   * from within that callback would deadlock: the outer task would wait on the inner one,
   * which waits on the outer one finishing first).
   */
  private async runClaudeTask(chatId: number, prompt: string, label = prompt): Promise<void> {
    const pendingId = chatState.startPendingTask(chatId, label);
    let ok = false;
    const started = Date.now();
    try {
      await this.sendTyping(chatId);
      await this.sendProgress(chatId, '🤖 Claude Code is working…');
      const result = await this.claudeBridge.run(chatId, prompt, {
        onProgress: (t) => void this.sendProgressThrottled(chatId, `🤖 Claude Code:\n${this.tail(t)}`),
      });
      await this.clearProgress(chatId);
      ok = result.success;
      this.toastIfLong(started, label, result.success ? result.output : `Failed: ${result.error}`);
      if (result.success) {
        await this.sendLong(chatId, result.output || '✅ Done (no output).');
      } else {
        await this.sendLong(chatId, `❌ Claude Code failed: ${result.error}${result.output ? '\n\n' + result.output : ''}`);
      }
      await this.bot.telegram.sendMessage(chatId, 'Anything else to delegate?');
    } finally {
      chatState.finishPendingTask(pendingId, ok ? 'done' : 'failed');
    }
  }

  /** Screenshots and reports: photo when small enough, otherwise as a file. */
  private async sendFile(chatId: number, file: string, kind: 'photo' | 'document', caption?: string): Promise<void> {
    if (kind === 'photo') await this.bot.telegram.sendPhoto(chatId, { source: file }, { caption });
    else await this.bot.telegram.sendDocument(chatId, { source: file, filename: path.basename(file) }, { caption });
  }

  /** A Windows notification when a task took long enough that you may have walked away. */
  private toastIfLong(started: number, label: string, result: string): void {
    if (Date.now() - started < config.toast.longTaskSeconds * 1000) return;
    this.toast.notify(`Task finished: ${label.slice(0, 60)}`, result.slice(0, 250));
  }

  /**
   * A photo (or image file) from the phone: "what does this error mean?" — saved to a temp
   * file Claude Code opens with its Read tool, then deleted. Always Claude Code: the local
   * models can't see images.
   */
  private handlePhoto(ctx: Context, fileId: string, caption: string): Promise<unknown> | void {
    if (this.paused) return ctx.reply('⏸ Bot is paused. Use /resume to continue.');
    const chatId = ctx.chat!.id;
    void this.orchestrator.submit(chatId, async () => {
      const dir = path.join(os.tmpdir(), 'aiwa-photos');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`);
      try {
        const link = await this.bot.telegram.getFileLink(fileId);
        const res = await axios.get<ArrayBuffer>(link.toString(), { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 20 * 1024 * 1024 });
        fs.writeFileSync(file, Buffer.from(res.data));
        const ask = caption.trim() || 'What is in this picture? If it shows an error or a problem on a Windows PC, explain it simply and say how to fix it.';
        await this.runClaudeTask(chatId, `${ask}\n\n[The user sent a picture from their phone. It is saved at ${file} — open it with the Read tool to see it.]`, `📷 ${ask.slice(0, 80)}`);
      } catch (err) {
        await this.sendLong(chatId, `❌ Could not process the picture: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        fs.rmSync(file, { force: true });
      }
    });
  }

  // ---------- approvals ----------

  /** Public: also used by ApprovalHookServer to gate Claude Code's own tool calls. */
  requestApproval = (chatId: number, description: string, grantKey?: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const id = uuidv4().slice(0, 8);
      const timer = setTimeout(() => {
        if (this.pendingApprovals.delete(id)) {
          this.toast.remove(id);
          this.bot.telegram.sendMessage(chatId, '⏱ Approval expired — action cancelled.').catch(() => undefined);
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      const nonce = crypto.randomBytes(16).toString('hex');
      const pending: PendingApproval = { chatId, description, resolve, timer, nonce, grantKey };
      this.pendingApprovals.set(id, pending);
      // at the PC too: a Windows notification with Approve / Deny (first answer wins)
      this.toast.approval(id, nonce, description);
      const reply_markup = {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `appr:${id}` },
            { text: '❌ Deny', callback_data: `deny:${id}` },
          ],
          // bursts of small steps in one place (UI clicks in one window): approve them all for 10 min
          ...(grantKey ? [[{ text: '⏱ Approve all here for 10 min', callback_data: `gr10:${id}` }]] : []),
        ],
      };
      // Commands are full of Markdown characters ($_.Name, *.txt): when Telegram rejects the
      // Markdown, send the same text plain instead of silently treating it as a denial.
      this.bot.telegram
        .sendMessage(chatId, `⚠️ *Approval required*\n${description}`, { parse_mode: 'Markdown', reply_markup })
        .catch(() => this.bot.telegram.sendMessage(chatId, `⚠️ Approval required\n${description}`, { reply_markup }))
        .then((msg) => {
          pending.messageId = msg.message_id;
        })
        .catch((err) => {
          // Telegram unreachable: the Windows notification may still be answered at the PC
          this.logger?.error({ err }, 'failed to send approval request');
          if (!this.toast.enabled) this.settleApproval(id, false, 'error');
        });
    });
  };

  /** One answer per approval, from Telegram or the PC (Windows notification). False if already settled. */
  /** An Approve / Deny / 10-min button (callback data "appr:id"…). null = expired or already answered. */
  answerButton(data: string, via: 'Telegram' | 'chat window'): boolean | null {
    const [action, id] = data.split(':');
    const approved = action === 'appr' || action === 'gr10';
    const p = this.pendingApprovals.get(id);
    if (action === 'gr10' && p?.grantKey) grant(p.chatId, p.grantKey, 10);
    return this.settleApproval(id, approved, via) ? approved : null;
  }

  private settleApproval(id: string, approved: boolean, via: 'Telegram' | 'this PC' | 'chat window' | 'error'): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) return false;
    this.pendingApprovals.delete(id);
    clearTimeout(pending.timer);
    if (via !== 'this PC') this.toast.remove(id);
    if (pending.messageId) {
      const text = `${pending.description}\n\n${approved ? '✅ Approved' : '❌ Denied'}${via === 'this PC' ? ' (at the PC)' : via === 'chat window' ? ' (in the chat window)' : ''}`;
      this.bot.telegram
        .editMessageText(pending.chatId, pending.messageId, undefined, text, { parse_mode: 'Markdown' })
        .catch(() => this.bot.telegram.editMessageText(pending.chatId, pending.messageId, undefined, text.replace(/[*_`]/g, '')))
        .catch(() => undefined);
    }
    pending.resolve(approved);
    return true;
  }

  /** ApprovalHookServer /toast: a click on a Windows notification's Approve/Deny button. */
  handleToastAction = (nonce: string, approve: boolean): boolean => {
    for (const [id, p] of this.pendingApprovals) if (p.nonce === nonce) return this.settleApproval(id, approve, 'this PC');
    return false;
  };

  // ---------- telegram helpers ----------

  private async sendTyping(chatId: number): Promise<void> {
    await this.bot.telegram.sendChatAction(chatId, 'typing').catch(() => undefined);
  }

  private async sendProgress(chatId: number, text: string): Promise<void> {
    try {
      const existing = this.progressMsgId.get(chatId);
      if (existing) {
        await this.bot.telegram.editMessageText(chatId, existing, undefined, this.tail(text));
      } else {
        const msg = await this.bot.telegram.sendMessage(chatId, this.tail(text));
        this.progressMsgId.set(chatId, msg.message_id);
      }
      this.lastProgressEdit.set(chatId, Date.now());
    } catch {
      /* edit races are harmless */
    }
  }

  /** Throttled progress edit (Telegram rate-limits edits). */
  private async sendProgressThrottled(chatId: number, text: string): Promise<void> {
    const last = this.lastProgressEdit.get(chatId) || 0;
    if (Date.now() - last < 1500) return;
    await this.sendProgress(chatId, text);
  }

  private async clearProgress(chatId: number): Promise<void> {
    const id = this.progressMsgId.get(chatId);
    this.progressMsgId.delete(chatId);
    if (id) await this.bot.telegram.deleteMessage(chatId, id).catch(() => undefined);
  }

  private tail(text: string, max = 500): string {
    return text.length > max ? '…' + text.slice(-max) : text;
  }

  /** Split at Telegram's 4096-char limit (same as AiAgentAssistant). */
  private async sendLong(chatId: number, text: string): Promise<void> {
    if (!text) text = '(no output)';
    for (let i = 0; i < text.length; i += TG_LIMIT) {
      const chunk = text.slice(i, i + TG_LIMIT);
      try {
        await this.bot.telegram.sendMessage(chatId, chunk);
      } catch {
        await this.bot.telegram.sendMessage(chatId, chunk.replace(/[*_`[\]]/g, '')).catch(() => undefined);
      }
    }
  }

  // ---------- lifecycle ----------

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.onPauseChanged?.(paused);
  }

  async launch(): Promise<void> {
    await this.bot.telegram.setMyCommands([
      { command: 'task', description: 'Delegate a task' },
      { command: 'claude', description: 'Send prompt to Claude Code' },
      { command: 'execute', description: 'Run a PowerShell command' },
      { command: 'ai', description: 'Force full AI loop' },
      { command: 'provider', description: 'Show/switch AI provider' },
      { command: 'aimodel', description: 'Show/change model' },
      { command: 'status', description: 'Bot status' },
      { command: 'doctor', description: 'Check everything works' },
      { command: 'screenshot', description: 'Screenshot of the PC' },
      { command: 'settings', description: 'Open a Settings page' },
      { command: 'cleanup', description: 'Free disk space' },
      { command: 'health', description: 'PC health report (PDF)' },
      { command: 'apps', description: 'Install/update apps (winget)' },
      { command: 'admin', description: 'Administrator jobs' },
      { command: 'fix', description: 'Repair routines' },
      { command: 'alerts', description: 'Proactive alerts' },
      { command: 'clear', description: 'Reset conversation' },
      { command: 'cancel', description: 'Cancel running task' },
      { command: 'pause', description: 'Pause bot' },
      { command: 'resume', description: 'Resume bot' },
      { command: 'help', description: 'Help' },
    ]);
    // Long polling, same as AiAgentAssistant
    void this.bot.launch({ dropPendingUpdates: true });
    const me = await this.bot.telegram.getMe();
    this.botUsername = me.username || '';
    this.logger?.info({ username: this.botUsername }, 'telegram bot launched');
  }

  /** Set by index.ts when the chat window runs. */
  webChat?: WebChat;
  /** Set by index.ts: proactive alerts, for /alerts. */
  alerts?: AlertService;

  private mirror(method: string, p: Record<string, unknown>, res: { message_id?: number }): void {
    if (!this.webChat || !this.isAllowed(Number(p.chat_id))) return;
    if (method === 'sendMessage') {
      const kb = (p.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)?.inline_keyboard || [];
      const buttons = kb.flat().filter((b) => b.callback_data).map((b) => [b.text, b.callback_data!] as [string, string]);
      this.webChat.push({ mid: res?.message_id, who: 'bot', text: String(p.text || ''), buttons });
    } else if (method === 'editMessageText') {
      this.webChat.push({ mid: Number(p.message_id), who: 'bot', text: String(p.text || '') });
    } else if (method === 'deleteMessage') {
      this.webChat.push({ mid: Number(p.message_id), who: 'bot', text: '', deleted: true });
    } else if (method === 'sendPhoto' || method === 'sendDocument') {
      this.webChat.push({ who: 'note', text: `📎 ${String(p.caption || 'A file')} — sent to Telegram` });
    }
  }

  /** Text typed in the chat window: handled exactly like a Telegram message from the owner. */
  injectOwnerText(text: string): void {
    const [owner] = config.telegram.allowedUsers;
    if (!owner) return;
    const command = /^\/\w+/.exec(text);
    const update = {
      update_id: 0,
      message: {
        message_id: 0,
        date: Math.floor(Date.now() / 1000),
        chat: { id: owner, type: 'private', first_name: 'PC' },
        from: { id: owner, is_bot: false, first_name: 'PC' },
        text,
        ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] } : {}),
      },
    };
    void this.bot.handleUpdate(update as unknown as Parameters<Telegraf['handleUpdate']>[0]).catch((err) => this.logger?.error({ err }, 'chat window message failed'));
  }

  async notifyOwner(text: string): Promise<void> {
    const [owner] = config.telegram.allowedUsers;
    if (owner) await this.bot.telegram.sendMessage(owner, text).catch(() => undefined);
  }

  stop(reason: string): void {
    this.bot.stop(reason);
  }
}
