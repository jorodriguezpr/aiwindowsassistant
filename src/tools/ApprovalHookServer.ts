/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import * as http from 'http';
import * as path from 'path';
import * as crypto from 'crypto';
import { config } from '../config';
import { classifyCommand, PolicyDecision } from '../security/CommandPolicy';
import { sensitivePathIn } from '../security/SensitivePaths';
import type { Logger } from '../logger';

export type ApprovalRequester = (chatId: number, description: string) => Promise<boolean>;

interface HookApprovalBody {
  chatId: number;
  toolName: string;
  toolInput: Record<string, unknown>;
}

function isWithinWorkspace(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const root = path.resolve(config.claude.workspace);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** Tools that only read: allowed, unless they point at a protected location. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** The same policy as the local engine's tools (AITools.toolCallDecision), applied to Claude
 * Code's own built-in tools. Bash on Windows is Git Bash; PowerShell is its separate tool. */
export function claudeToolDecision(toolName: string, toolInput: Record<string, unknown>): PolicyDecision {
  const str = (k: string) => (typeof toolInput[k] === 'string' ? (toolInput[k] as string) : '');
  if (toolName === 'Bash' || toolName === 'PowerShell') return classifyCommand(str('command'), toolName === 'Bash' ? 'bash' : 'powershell');
  const target = str('file_path') || str('notebook_path') || str('path');
  const sensitive = sensitivePathIn([target, str('pattern'), str('glob')].join(' '));
  if (sensitive && (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName))) return { verdict: 'deny', reason: `touches a protected location (${sensitive})` };
  if (WRITE_TOOLS.has(toolName) && target) {
    // Routine edits inside the configured workspace match acceptEdits expectations —
    // only gate writes that reach outside it.
    return isWithinWorkspace(target) ? { verdict: 'allow', reason: 'inside the workspace' } : { verdict: 'ask', reason: 'writes outside the workspace' };
  }
  return { verdict: 'allow', reason: 'read-only tool' };
}

function describeToolCall(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash' || toolName === 'PowerShell') return `Run (${toolName}): ${String(toolInput.command || '').slice(0, 300)}`;
  if (typeof toolInput.file_path === 'string') return `${toolName}: ${toolInput.file_path}`;
  return `${toolName}(${JSON.stringify(toolInput).slice(0, 200)})`;
}

/**
 * Loopback-only HTTP server that scripts/claude-approval-hook.js (a Claude Code
 * PreToolUse hook) calls to gate the tool calls Claude Code makes on its own,
 * reusing the same Telegram approval flow AgentLoop's tools already use.
 * Fails closed on any error — an unparseable or unhandled request is denied,
 * never silently allowed.
 *
 * Every request must carry the per-run random token (Authorization: Bearer …) that the bridge
 * hands the hook via AIWA_APPROVAL_TOKEN: other local programs that find the port get 401
 * instead of being able to put fake approval prompts on the owner's phone.
 */
export class ApprovalHookServer {
  private server: http.Server;
  port = 0;
  /** Random per run; ClaudeCodeBridge passes it to the hook through the environment. */
  readonly token = crypto.randomBytes(32).toString('hex');

  constructor(
    private requestApproval: ApprovalRequester,
    private logger?: Logger
  ) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  private authorized(req: http.IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from(`Bearer ${this.token}`);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  /** Set by the gateway: a Windows notification's Approve/Deny click (see ToastService). */
  onToastAction?: (nonce: string, approve: boolean) => boolean;

  private handleToast(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
      if (body.length > 1000) req.destroy();
    });
    req.on('end', () => {
      let handled = false;
      try {
        const { nonce, approve } = JSON.parse(body) as { nonce?: string; approve?: boolean };
        // the nonce is the authorization: random per approval, only ever shown in that toast
        if (typeof nonce === 'string' && /^[a-f0-9]{32}$/.test(nonce)) handled = !!this.onToastAction?.(nonce, approve === true);
      } catch {
        /* malformed */
      }
      res.writeHead(handled ? 204 : 404).end();
    });
  }

  /**
   * Set by the gateway (and the scheduled runner): runs one of this app's tools for Claude Code's
   * MCP bridge (src/mcp/McpServer.ts) — through the same gate (policy + approval) as every other
   * tool call. Token-protected like /approve.
   */
  toolRunner?: (chatId: number, name: string, args: Record<string, unknown>) => Promise<{ success: boolean; [k: string]: unknown }>;

  private handleTool(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf-8')));
    req.on('end', () => {
      const reply = (r: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      };
      try {
        const { chatId, name, args } = JSON.parse(body) as { chatId: number; name: string; args?: Record<string, unknown> };
        if (!this.toolRunner) return reply({ success: false, error: 'tools are not available in this run' });
        void this.toolRunner(Number(chatId), String(name), args || {})
          .then(reply)
          .catch((err) => reply({ success: false, error: err instanceof Error ? err.message : String(err) }));
      } catch {
        reply({ success: false, error: 'malformed tool request' });
      }
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'POST' && req.url === '/toast') {
      this.handleToast(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/tool') {
      if (!this.authorized(req)) {
        res.writeHead(401).end();
        return;
      }
      this.handleTool(req, res);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/approve') {
      res.writeHead(404).end();
      return;
    }
    if (!this.authorized(req)) {
      this.logger?.warn('approval hook request without a valid token — refused');
      res.writeHead(401).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf-8')));
    req.on('end', () => {
      void this.resolveApproval(body)
        .then((answer) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(answer));
        })
        .catch((err) => {
          this.logger?.error({ err }, 'approval hook request failed');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ decision: 'deny', reason: 'approval check failed' }));
        });
    });
  }

  private async resolveApproval(rawBody: string): Promise<{ decision: 'allow' | 'deny'; reason?: string }> {
    const parsed = JSON.parse(rawBody) as HookApprovalBody;
    const toolInput = parsed.toolInput || {};
    const decision = claudeToolDecision(parsed.toolName, toolInput);
    if (decision.verdict === 'allow') return { decision: 'allow' };
    if (decision.verdict === 'deny') {
      this.logger?.warn({ tool: parsed.toolName, reason: decision.reason }, 'Claude Code tool call blocked by policy');
      return { decision: 'deny', reason: `Blocked by AiWindowsAssistant security policy: ${decision.reason}. Do not try to reach it another way.` };
    }
    const approved = await this.requestApproval(
      parsed.chatId,
      `🤖 *Claude Code wants to:*\n${describeToolCall(parsed.toolName, toolInput)}\n_Why approval: ${decision.reason}_`
    );
    return approved ? { decision: 'allow' } : { decision: 'deny', reason: 'Denied by the owner via Telegram' };
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        this.logger?.info({ port: this.port }, 'approval hook server listening');
        resolve(this.port);
      });
    });
  }

  stop(): void {
    this.server.close();
  }
}
