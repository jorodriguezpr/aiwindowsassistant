/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import * as http from 'http';
import * as path from 'path';
import { config } from '../config';
import { isDestructiveCommand } from './AITools';
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

/** Mirrors AITools.ts's destructive-tool gating, applied to Claude Code's own built-in tools. */
function isDestructiveClaudeToolCall(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return isDestructiveCommand(toolInput.command);
  }
  if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') && typeof toolInput.file_path === 'string') {
    // Routine edits inside the configured workspace match acceptEdits expectations —
    // only gate writes that reach outside it.
    return !isWithinWorkspace(toolInput.file_path);
  }
  return false;
}

function describeToolCall(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash') return `Run: ${String(toolInput.command || '').slice(0, 150)}`;
  if (typeof toolInput.file_path === 'string') return `${toolName}: ${toolInput.file_path}`;
  return `${toolName}(${JSON.stringify(toolInput).slice(0, 120)})`;
}

/**
 * Loopback-only HTTP server that scripts/claude-approval-hook.js (a Claude Code
 * PreToolUse hook) calls to gate destructive tool calls Claude Code makes on its
 * own, reusing the same Telegram approval flow AgentLoop's tools already use.
 * Fails closed on any error — an unparseable or unhandled request is denied,
 * never silently allowed.
 */
export class ApprovalHookServer {
  private server: http.Server;
  port = 0;

  constructor(
    private requestApproval: ApprovalRequester,
    private logger?: Logger
  ) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/approve') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf-8')));
    req.on('end', () => {
      void this.resolveApproval(body)
        .then((decision) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ decision }));
        })
        .catch((err) => {
          this.logger?.error({ err }, 'approval hook request failed');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ decision: 'deny' }));
        });
    });
  }

  private async resolveApproval(rawBody: string): Promise<'allow' | 'deny'> {
    const parsed = JSON.parse(rawBody) as HookApprovalBody;
    const toolInput = parsed.toolInput || {};
    if (!isDestructiveClaudeToolCall(parsed.toolName, toolInput)) return 'allow';
    const approved = await this.requestApproval(
      parsed.chatId,
      `⚠️ *Claude Code — destructive action*\n${describeToolCall(parsed.toolName, toolInput)}`
    );
    return approved ? 'allow' : 'deny';
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
