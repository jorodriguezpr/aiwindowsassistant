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

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown; // tool_result payload: string | Array<{type:'text', text:string}> | other
  is_error?: boolean;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
  permission_denials?: unknown[];
}

/** Icon per Claude Code tool name, purely cosmetic — mirrors AgentLoop's emoji-prefixed tool descriptions. */
const TOOL_ICONS: Record<string, string> = {
  Bash: '⚙️', Read: '📖', Write: '📝', Edit: '✏️', MultiEdit: '✏️',
  NotebookEdit: '📓', Glob: '🔍', Grep: '🔍', WebFetch: '🌐', WebSearch: '🌐',
  Task: '🧩', TodoWrite: '☑️',
};

function truncate(s: string, max = 140): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Renders an absolute path relative to cwd when that's shorter/cleaner, same as Claude Code's own display. */
function shortenPath(value: unknown, cwd: string): string {
  if (typeof value !== 'string' || !value) return String(value ?? '');
  try {
    const rel = path.relative(cwd, value);
    return rel && !rel.startsWith('..') ? rel : value;
  } catch {
    return value;
  }
}

/** Formats a tool_use block the way Claude Code's own CLI compact view does: Tool(key detail). */
function describeToolUse(name: string, input: Record<string, unknown>, cwd: string): string {
  const icon = TOOL_ICONS[name] || '🔧';
  let detail: string;
  switch (name) {
    case 'Bash': {
      const description = typeof input.description === 'string' ? input.description : '';
      const command = typeof input.command === 'string' ? input.command : '';
      detail = description ? `${description} ($ ${truncate(command, 80)})` : `$ ${truncate(command)}`;
      break;
    }
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit':
      detail = `(${shortenPath(input.file_path, cwd)})`;
      break;
    case 'NotebookEdit':
      detail = `(${shortenPath(input.notebook_path, cwd)})`;
      break;
    case 'Glob': case 'Grep':
      detail = `(${truncate(String(input.pattern ?? ''))})`;
      break;
    case 'WebFetch':
      detail = `(${truncate(String(input.url ?? ''))})`;
      break;
    case 'WebSearch':
      detail = `(${truncate(String(input.query ?? ''))})`;
      break;
    case 'Task':
      detail = `(${truncate(String(input.description ?? input.subagent_type ?? ''))})`;
      break;
    case 'TodoWrite':
      detail = `(${Array.isArray(input.todos) ? input.todos.length : '?'} items)`;
      break;
    default:
      detail = `(${truncate(JSON.stringify(input ?? {}))})`;
  }
  return name === 'Bash' ? `${icon} ${detail}` : `${icon} ${name}${detail}`;
}

/** Flattens a tool_result's content (string, or Anthropic content-block array) into plain text. */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join(' ');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
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
            // PowerShell is a separate tool from Bash on this Claude Code version — a Windows
            // command-execution path that was left completely ungated until this was found (see
            // EscalationPollService's read-only hook, which caught the same gap and proved it:
            // denying Bash's `dir` just made Claude Code retry via PowerShell unrestricted).
            matcher: 'Bash|PowerShell|Write|Edit|NotebookEdit',
            hooks: [{ type: 'command', command: `node "${hookScript}"`, timeout: 300 }],
          },
        ],
      },
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
  }

  /**
   * npm's global install generates a `claude.cmd` shim whose only job is
   * `"<shim-dir>\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*`. Running a .cmd
   * file at all requires spawning it through `cmd.exe /c` (Windows can't exec a batch file
   * directly) — and cmd.exe fundamentally cannot pass an argument containing a literal newline
   * through unmangled; it truncates at the first one. Every multi-line prompt (every Fleet
   * Guardian escalation, since the drafted prompt always has a "Title:\n\n<description>" shape)
   * silently lost everything after its first line this way, producing a fast, empty-looking
   * response with no error — proven via direct spawn repro, not guessed. The real .exe the shim
   * wraps is a normal native binary; spawning it directly needs no shell at all, so this
   * resolves it whenever a .cmd shim is found, at any location, not just the default npm dir.
   */
  private realExeNextToShim(cmdPath: string): string | null {
    const real = path.join(path.dirname(cmdPath), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    return fs.existsSync(real) ? real : null;
  }

  /** Resolve the claude executable: config -> npm shim dir -> PATH lookup. Always prefers the
   * real .exe behind a .cmd shim over the shim itself — see realExeNextToShim(). */
  resolveCliPath(): string | null {
    if (config.claude.cliPath && fs.existsSync(config.claude.cliPath)) return config.claude.cliPath;
    // Prefer the .cmd shim in the npm global dir (npm global bin is on PATH)
    const npmDir = path.join(process.env.APPDATA || '', 'npm');
    const preferred = [path.join(npmDir, 'claude.cmd'), path.join(npmDir, 'claude.exe')];
    for (const c of preferred) {
      if (!fs.existsSync(c)) continue;
      if (c.toLowerCase().endsWith('.cmd')) {
        const real = this.realExeNextToShim(c);
        if (real) return real;
      }
      return c;
    }
    try {
      const out = execSync('where claude', { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      // Prefer .cmd/.exe — the extensionless entry is a POSIX shell script that
      // cannot be spawned directly on Windows (spawn ENOENT).
      const sorted = [...lines.filter((l) => /\.(cmd|exe)$/i.test(l)), ...lines.filter((l) => !/\.(cmd|exe)$/i.test(l))];
      if (sorted.length > 0) {
        const found = sorted[0];
        if (found.toLowerCase().endsWith('.cmd')) {
          const real = this.realExeNextToShim(found);
          if (real) return real;
        }
        return found;
      }
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
   * onProgress receives throttled assistant text, plus an immediate line for every tool call
   * (Read/Edit/Bash/...) and tool error, so Telegram can show what Claude Code is doing in
   * something like the same detail as the Claude Code CLI itself.
   */
  run(
    chatId: number,
    prompt: string,
    opts?: { cwd?: string; onProgress?: (partialText: string) => void; hookSettingsPath?: string }
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
    // The prompt goes over stdin (written just after spawn, below), NOT as a `-p <prompt>`
    // argument — confirmed real failure: BJavaDecompiler's AI-delegation prompts (a batch of
    // decompiled Java classes) are routinely tens of KB, and Windows' CreateProcess has a hard
    // ~32K-character ceiling on the ENTIRE assembled command line; routing through cmd.exe for a
    // .cmd shim (see needsShell below) tightens that further to ~8K. Either way, a long enough
    // prompt makes Node's own spawn() throw `ENAMETOOLONG` before the process even starts. `-p`
    // with no inline argument reads the prompt from stdin instead, which has no such limit.
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    if (config.claude.permissionMode) {
      args.push('--permission-mode', config.claude.permissionMode);
    }
    // opts.hookSettingsPath (used by EscalationPollService) unconditionally denies
    // Bash/Write/Edit/NotebookEdit — a blanket read-only policy, not the nuanced
    // destructive/in-workspace check writeHookSettings()+ApprovalHookServer applies for the
    // interactive/scheduled paths. Takes priority over the approval-hook wiring below.
    if (opts?.hookSettingsPath) {
      args.push('--settings', opts.hookSettingsPath);
    } else if (this.approvalHookPort > 0) {
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

      // Swallow EPIPE/etc if the child exits before (or while) we're still writing — e.g. a bad
      // CLI path — so that shows up as the normal 'error'/'close' handling below instead of an
      // unhandled exception on the stdin stream itself.
      proc.stdin?.on('error', () => {});
      proc.stdin?.end(prompt, 'utf8');

      this.running.set(chatId, proc);

      let stdoutBuf = '';
      let stderrBuf = '';
      let newSessionId = sessionId;
      let lastText = '';
      let finalResult = '';
      let isError = false;
      let deniedToolCalls = 0;
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
          // Tool calls are discrete, infrequent events (unlike text deltas) — surface each one
          // immediately rather than gating on lastProgressSent, so Telegram shows what Claude
          // Code is actually doing (Read/Edit/Bash/...) instead of going quiet mid-task.
          for (const block of evt.message.content) {
            if (block.type === 'tool_use' && block.name) {
              try {
                opts?.onProgress?.(describeToolUse(block.name, block.input || {}, cwd));
              } catch {
                /* progress is best-effort */
              }
            }
          }
        } else if (evt.type === 'user' && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === 'tool_result' && block.is_error) {
              try {
                opts?.onProgress?.(`⚠️ Tool error: ${truncate(extractToolResultText(block.content), 200)}`);
              } catch {
                /* progress is best-effort */
              }
            }
          }
        } else if (evt.type === 'result') {
          finalResult = typeof evt.result === 'string' ? evt.result : lastText;
          isError = !!evt.is_error;
          deniedToolCalls = Array.isArray(evt.permission_denials) ? evt.permission_denials.length : 0;
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
        const emptyOutputFallback = deniedToolCalls > 0
          ? `(No text response — Claude Code attempted ${deniedToolCalls} tool call(s) that this run's read-only policy denied, `
            + `and ended the turn without further explanation. Try rephrasing the prompt to explicitly ask for read-only `
            + `analysis, e.g. "using only Read/Grep/Glob, investigate...".)`
          : '(no output)';
        if (code === 0 && !isError) {
          finish({ success: true, output: output || emptyOutputFallback, sessionId: newSessionId, durationMs: Date.now() - started });
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
