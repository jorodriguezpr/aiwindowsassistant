/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';
import * as chatState from '../db/ChatStateStore';
import type { Logger } from '../logger';

export interface ClaudeRunResult {
  success: boolean;
  output: string;
  sessionId?: string;
  error?: string;
  durationMs: number;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type: string; text?: string }> };
  result?: string;
  is_error?: boolean;
}

/**
 * Gateway to Claude Code: spawns the `claude` CLI in headless print mode with
 * stream-json output. This is the same engine that powers the Claude Code tab
 * in VS Code, so tasks delegated from Telegram behave as if typed there.
 *
 * Sessions: each Telegram chat gets its own Claude Code session; follow-up
 * messages resume it with --resume so context carries over.
 */
export class ClaudeCodeBridge {
  // Session IDs persist via ChatStateStore (SQLite) so a chat's Claude Code session survives
  // an app restart — the CLI's own on-disk session storage already has the conversation, this
  // just needs to remember which session ID belongs to which chat across process lifetimes.
  private running = new Map<number, ChildProcess>(); // chatId -> active process
  private logger?: Logger;
  /** Port of the local ApprovalHookServer, set once it's listening (index.ts). 0 = not wired yet. */
  private approvalHookPort = 0;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  setApprovalHookPort(port: number): void {
    this.approvalHookPort = port;
  }

  /**
   * Writes the PreToolUse hook registration Claude Code loads via --settings.
   * Written fresh into data/ (gitignored, machine-specific) rather than a
   * committed static file, since it embeds this install's absolute paths —
   * a checked-in file with a baked-in absolute path would break on any other
   * machine/install location. Never touches the target workspace's own
   * .claude/settings.json.
   */
  private writeHookSettings(): string {
    const hookScript = path.join(config.projectRoot, 'scripts', 'claude-approval-hook.js');
    const settingsPath = path.join(config.dataDir, 'claude-hooks-settings.json');
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash|Write|Edit|NotebookEdit',
            hooks: [{ type: 'command', command: `node "${hookScript}"`, timeout: 300 }],
          },
        ],
      },
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
  }

  /** Resolve the claude executable: config -> npm shim dir -> PATH lookup. */
  resolveCliPath(): string | null {
    if (config.claude.cliPath && fs.existsSync(config.claude.cliPath)) return config.claude.cliPath;
    // Prefer the .cmd shim in the npm global dir (npm global bin is on PATH)
    const npmDir = path.join(process.env.APPDATA || '', 'npm');
    const preferred = [path.join(npmDir, 'claude.cmd'), path.join(npmDir, 'claude.exe')];
    for (const c of preferred) if (fs.existsSync(c)) return c;
    try {
      const out = execSync('where claude', { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      // Prefer .cmd/.exe — the extensionless entry is a POSIX shell script that
      // cannot be spawned directly on Windows (spawn ENOENT).
      const sorted = [...lines.filter((l) => /\.(cmd|exe)$/i.test(l)), ...lines.filter((l) => !/\.(cmd|exe)$/i.test(l))];
      if (sorted.length > 0) return sorted[0];
    } catch {
      /* not found */
    }
    // Common install locations
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
  }

  isAvailable(): boolean {
    return this.resolveCliPath() !== null;
  }

  hasSession(chatId: number): boolean {
    return chatState.getClaudeSession(chatId) !== undefined;
  }

  clearSession(chatId: number): void {
    chatState.clearClaudeSession(chatId);
  }

  cancel(chatId: number): boolean {
    const proc = this.running.get(chatId);
    if (proc) {
      proc.kill('SIGTERM');
      this.running.delete(chatId);
      return true;
    }
    return false;
  }

  isRunning(chatId: number): boolean {
    return this.running.has(chatId);
  }

  /**
   * Run a prompt through Claude Code headless.
   * onProgress receives throttled partial text so Telegram can edit a progress message.
   */
  run(
    chatId: number,
    prompt: string,
    opts?: { cwd?: string; onProgress?: (partialText: string) => void }
  ): Promise<ClaudeRunResult> {
    const started = Date.now();
    const cli = this.resolveCliPath();
    if (!cli) {
      return Promise.resolve({
        success: false,
        output: '',
        error:
          'Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code ' +
          'then run "claude" once to log in, or set CLAUDE_CODE_PATH in .env',
        durationMs: 0,
      });
    }

    const sessionId = chatState.getClaudeSession(chatId);
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    if (config.claude.permissionMode) {
      args.push('--permission-mode', config.claude.permissionMode);
    }
    if (this.approvalHookPort > 0) {
      args.push('--settings', this.writeHookSettings());
    } else {
      this.logger?.warn('approval hook server not wired — destructive Claude Code tool calls will not be gated');
    }

    const cwd = opts?.cwd || config.claude.workspace;
    this.logger?.info({ chatId, resume: !!sessionId, cwd }, 'claude run start');

    // Strip ANTHROPIC_API_KEY so `claude` always falls back to its own stored
    // subscription login (`claude login`) rather than an inherited/empty key
    // from this app's own .env silently switching it to metered API billing.
    const { ANTHROPIC_API_KEY: _unused, ...childEnv } = process.env;
    void _unused;
    if (this.approvalHookPort > 0) {
      childEnv.AIWA_CHAT_ID = String(chatId);
      childEnv.AIWA_APPROVAL_PORT = String(this.approvalHookPort);
    }

    return new Promise<ClaudeRunResult>((resolve) => {
      const lower = cli.toLowerCase();
      // Extensionless npm shims are POSIX shell scripts — route through cmd as well.
      const needsShell = lower.endsWith('.cmd') || lower.endsWith('.bat') || !lower.endsWith('.exe');
      const proc: ChildProcess = needsShell
        ? spawn('cmd.exe', ['/c', cli, ...args], { cwd, windowsHide: true, env: childEnv })
        : spawn(cli, args, { cwd, windowsHide: true, env: childEnv });

      this.running.set(chatId, proc);

      let stdoutBuf = '';
      let stderrBuf = '';
      let newSessionId = sessionId;
      let lastText = '';
      let finalResult = '';
      let isError = false;
      let lastProgressSent = 0;
      let settled = false;

      const finish = (result: ClaudeRunResult) => {
        if (settled) return;
        settled = true;
        this.running.delete(chatId);
        if (newSessionId) chatState.setClaudeSession(chatId, newSessionId);
        this.logger?.info(
          { chatId, success: result.success, ms: result.durationMs, session: newSessionId },
          'claude run end'
        );
        resolve(result);
      };

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        finish({
          success: false,
          output: lastText,
          sessionId: newSessionId,
          error: `Timed out after ${config.claude.timeoutMs}ms`,
          durationMs: Date.now() - started,
        });
      }, config.claude.timeoutMs);

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let evt: StreamEvent;
        try {
          evt = JSON.parse(line);
        } catch {
          return; // not JSON — ignore
        }
        if (evt.type === 'system' && evt.session_id) {
          newSessionId = evt.session_id;
        } else if (evt.type === 'assistant' && evt.message?.content) {
          const text = evt.message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text || '')
            .join('');
          if (text) {
            lastText = text;
            const now = Date.now();
            if (opts?.onProgress && now - lastProgressSent > 2000) {
              lastProgressSent = now;
              try {
                opts.onProgress(text);
              } catch {
                /* progress is best-effort */
              }
            }
          }
        } else if (evt.type === 'result') {
          finalResult = typeof evt.result === 'string' ? evt.result : lastText;
          isError = !!evt.is_error;
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf-8');
        let idx: number;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx);
          stdoutBuf = stdoutBuf.slice(idx + 1);
          handleLine(line);
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf-8');
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        finish({
          success: false,
          output: lastText,
          sessionId: newSessionId,
          error: `Failed to start Claude Code: ${err.message}`,
          durationMs: Date.now() - started,
        });
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (stdoutBuf.trim()) handleLine(stdoutBuf); // flush remainder
        const output = finalResult || lastText;
        if (code === 0 && !isError) {
          finish({ success: true, output: output || '(no output)', sessionId: newSessionId, durationMs: Date.now() - started });
        } else {
          finish({
            success: false,
            output,
            sessionId: newSessionId,
            error: stderrBuf.trim() || (isError ? output : `claude exited with code ${code}`),
            durationMs: Date.now() - started,
          });
        }
      });
    });
  }
}
