/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from '../config';
import type { ToolDefinition } from '../providers/AIProvider';
import type { ClaudeCodeBridge } from './ClaudeCodeBridge';
import { SYSADMIN_TOOL_DEFINITIONS, SYSADMIN_TOOL_NAMES, executeSysAdminTool } from './SysAdminTools';
import { EMAIL_TOOL_DEFINITIONS, executeEmailTool } from './EmailTools';
import { PDF_TOOL_DEFINITIONS, executePdfTool } from './PdfTools';
import { WINDOWS_TOOL_DEFINITIONS, WINDOWS_TOOL_NAMES, executeWindowsTool } from './WindowsTools';
import { UI_TOOL_DEFINITIONS, UI_TOOL_NAMES, executeUiTool } from './UiTools';
import { REPAIR_TOOL_DEFINITIONS, executeRepairTool, describeRoutine } from '../services/RepairService';
import { ELEVATED_OPS } from '../elevated/ops';
import { describeTargets } from '../services/CleanupService';
import { saveNote as saveNoteToDb } from '../db/NotesStore';
import { classifyCommand, PolicyDecision } from '../security/CommandPolicy';
import { sensitivePathIn } from '../security/SensitivePaths';
import { childEnv } from '../security/SecretStore';

const execAsync = promisify(exec);

export interface ToolContext {
  chatId: number;
  claudeBridge: ClaudeCodeBridge;
  /** Ask the user to approve a destructive action. Resolves true = approved. */
  requestApproval: (description: string, grantKey?: string) => Promise<boolean>;
  /** Progress updates for long-running tools (e.g. Claude Code runs). */
  onProgress?: (text: string) => void;
  /** Send a file to the user's chat (screenshots, PDF reports). */
  sendFile?: (filePath: string, kind: 'photo' | 'document', caption?: string) => Promise<void>;
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  [key: string]: unknown;
}

const DESTRUCTIVE_TOOLS = new Set(['delete_file', 'stop_process', 'service_control', 'firewall_rule_manage', 'send_email']);

function insideDir(p: string, dir: string): boolean {
  const resolved = path.resolve(p).toLowerCase();
  const root = path.resolve(dir).toLowerCase();
  return resolved === root || resolved.startsWith(root + path.sep);
}

const SCRIPT_OR_EXE = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|reg|scr|pif|cpl|lnk|jar)$/i;

/** launch_program: documents, URLs and installed apps open freely; scripts, shells, downloaded
 * executables and anything that could smuggle a second command into `start` ask first. */
function launchDecision(target: string, argsStr: string): PolicyDecision {
  const sensitive = sensitivePathIn(`${target} ${argsStr}`);
  if (sensitive) return { verdict: 'deny', reason: `touches a protected location (${sensitive})` };
  // the target and args are pasted into `cmd /c start …`: metacharacters would run another command
  if (/["&|<>^%\r\n]/.test(target) || /[&|<>^%\r\n]/.test(argsStr)) return { verdict: 'ask', reason: 'contains shell characters (&, |, >, %…)' };
  if (/^(https?|mailto|ms-settings):/i.test(target)) return { verdict: 'allow', reason: 'opens a link' };
  const name = path.basename(target).toLowerCase().replace(/\.(exe|com)$/, '');
  if (/^(powershell|pwsh|cmd|wscript|cscript|mshta|rundll32|regsvr32|wsl|bash|msiexec|reg|regedit|schtasks|sc|net|certutil|bitsadmin)$/.test(name))
    return { verdict: 'ask', reason: `starts ${name}, which can run any command` };
  if (SCRIPT_OR_EXE.test(target) && !/^[a-z]:\\(program files( \(x86\))?|windows)\\/i.test(path.resolve(target)) && /[\\/]/.test(target))
    return { verdict: 'ask', reason: 'runs a program or script from outside Program Files / Windows' };
  return { verdict: 'allow', reason: 'opens a document or installed app' };
}

/**
 * The policy verdict for one local-engine tool call: allow (run now), ask (owner approves in
 * Telegram) or deny (never). See src/security/CommandPolicy.ts.
 */
export function toolCallDecision(name: string, args: Record<string, unknown>): PolicyDecision {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  const pathArg = str('path') || str('directory');
  if (pathArg) {
    const sensitive = sensitivePathIn(pathArg);
    if (sensitive) return { verdict: 'deny', reason: `touches a protected location (${sensitive})` };
  }
  switch (name) {
    case 'execute_command': {
      const cwdSensitive = sensitivePathIn(str('cwd'));
      if (cwdSensitive) return { verdict: 'deny', reason: `runs inside a protected location (${cwdSensitive})` };
      return classifyCommand(str('command'), 'powershell');
    }
    case 'launch_program':
      return launchDecision(str('target'), str('args'));
    case 'write_file':
      // like Claude Code's acceptEdits: free inside the workspace and the documents folder
      return insideDir(str('path'), config.claude.workspace) || insideDir(str('path'), config.assistant.documentsDir)
        ? { verdict: 'allow', reason: 'inside the workspace' }
        : { verdict: 'ask', reason: 'writes outside the workspace' };
    case 'apps_install':
      return { verdict: 'ask', reason: `installs software (${str('app')})` };
    case 'apps_upgrade':
      return { verdict: 'ask', reason: `updates software (${str('app')})` };
    case 'clean_up_disk':
      return { verdict: 'ask', reason: `deletes files:
${describeTargets(str('targets'))}` };
    // UI Automation: looking is free; acting asks, approvable for 10 min per window (Gate.ts)
    case 'ui_click':
    case 'ui_type':
    case 'ui_keys': {
      const win = str('window').trim();
      const what = name === 'ui_click' ? `clicks "${str('target')}"` : name === 'ui_type' ? `types "${str('text').slice(0, 80)}"` : `presses ${str('keys')}`;
      return { verdict: 'ask', reason: `${what} in the window "${win}"`, grantKey: `ui:${win.toLowerCase()}` };
    }
    case 'ui_window':
      return str('action') === 'close' ? { verdict: 'ask', reason: `closes the window "${str('window')}" (unsaved work would be lost)` } : { verdict: 'allow', reason: 'arranges a window' };
    case 'run_repair': {
      const plan = describeRoutine(str('routine'));
      if (!plan) return { verdict: 'allow', reason: 'unknown routine (fails harmlessly)' };
      return plan.changes ? { verdict: 'ask', reason: `runs the repair routine:\n${plan.text}` } : { verdict: 'allow', reason: 'read-only diagnosis' };
    }
    case 'admin_task': {
      const op = ELEVATED_OPS[str('task')];
      if (!op) return { verdict: 'allow', reason: 'unknown task (fails harmlessly)' };
      return op.risk === 'change' ? { verdict: 'ask', reason: `runs as administrator: ${op.title}${str('param') ? ` (${str('param')})` : ''}` } : { verdict: 'allow', reason: 'read-only or harmless admin job' };
    }
    default:
      return DESTRUCTIVE_TOOLS.has(name) ? { verdict: 'ask', reason: 'changes the system' } : { verdict: 'allow', reason: 'read-only tool' };
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'execute_command',
    description:
      'Execute a shell command on this Windows 11 machine. Commands run via PowerShell. ' +
      'Use for system administration, file operations, git, npm, checking status, etc. ' +
      'Prefer PowerShell cmdlets (Get-ChildItem, Get-Content, etc.) over Linux commands.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'launch_program',
    description: 'Launch a Windows program or open a file/URL with its default application (non-blocking).',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Program name (code, notepad), full path, file, or URL' },
        args: { type: 'string', description: 'Optional arguments' },
      },
      required: ['target'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for files by name pattern and/or text content under a directory. Skips node_modules, .git, dist.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory to search in' },
        namePattern: { type: 'string', description: 'Substring or *.ext pattern to match file names (optional)' },
        contentPattern: { type: 'string', description: 'Text to search for inside files (optional)' },
        maxResults: { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a text file (optionally a line range).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write text content to a file (creates directories as needed).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file or folder (destructive — requires user approval).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
      },
      required: ['path'],
    },
  },
  {
    name: 'stop_process',
    description: 'Stop a running process by name or PID (destructive — requires user approval).',
    parameters: {
      type: 'object',
      properties: {
        nameOrPid: { type: 'string', description: 'Process name (e.g. node) or PID' },
      },
      required: ['nameOrPid'],
    },
  },
  {
    name: 'get_system_info',
    description: 'Get Windows system info: OS, CPU, memory, uptime, disk, node version.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'delegate_to_claude_code',
    description:
      'Delegate a coding/development task to Claude Code (the same engine as the VS Code Claude Code tab). ' +
      'Runs headless in the configured workspace with full agentic capabilities (edit files, run tests, git). ' +
      'Use for any non-trivial coding task, refactoring, debugging, or multi-step project work. ' +
      'Each chat has a persistent Claude Code session — follow-up requests continue the same session.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task to delegate, phrased as you would type it in Claude Code' },
        cwd: { type: 'string', description: 'Workspace folder for the task (defaults to CLAUDE_WORKSPACE)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'save_note',
    description:
      'Save a durable fact worth recalling in future conversations — infrastructure details, preferences, ' +
      'recurring patterns. Not for transient task details. Shown back to you as a digest on future runs.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        tags: { type: 'string', description: 'Optional comma-separated tags' },
      },
      required: ['summary'],
    },
  },
  ...SYSADMIN_TOOL_DEFINITIONS,
  ...EMAIL_TOOL_DEFINITIONS,
  ...PDF_TOOL_DEFINITIONS,
  ...WINDOWS_TOOL_DEFINITIONS,
  ...UI_TOOL_DEFINITIONS,
  ...REPAIR_TOOL_DEFINITIONS,
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '$RECYCLE.BIN']);

export class AIToolExecutor {
  async execute(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson || '{}');
    } catch {
      return { success: false, error: `Invalid JSON arguments for ${name}` };
    }
    try {
      return await this.dispatch(name, args, ctx);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    switch (name) {
      case 'execute_command':
        return this.executeCommand(String(args.command || ''), args.cwd ? String(args.cwd) : undefined);
      case 'launch_program':
        return this.launchProgram(String(args.target || ''), args.args ? String(args.args) : undefined);
      case 'search_files':
        return this.searchFiles(
          String(args.directory || ''),
          args.namePattern ? String(args.namePattern) : undefined,
          args.contentPattern ? String(args.contentPattern) : undefined,
          typeof args.maxResults === 'number' ? args.maxResults : 50
        );
      case 'read_file':
        return this.readFile(String(args.path || ''), args.startLine as number | undefined, args.endLine as number | undefined);
      case 'write_file':
        return this.writeFile(String(args.path || ''), String(args.content ?? ''));
      case 'list_directory':
        return this.listDirectory(String(args.path || ''));
      case 'delete_file':
        return this.deleteFile(String(args.path || ''), !!args.recursive);
      case 'stop_process':
        return this.stopProcess(String(args.nameOrPid || ''));
      case 'get_system_info':
        return this.getSystemInfo();
      case 'delegate_to_claude_code':
        return this.delegateToClaudeCode(String(args.prompt || ''), args.cwd ? String(args.cwd) : undefined, ctx);
      case 'save_note':
        return this.saveNote(String(args.summary || ''), args.tags ? String(args.tags) : undefined);
      case 'send_email':
        return executeEmailTool(name, args);
      case 'generate_pdf':
        return executePdfTool(name, args);
      default:
        if (SYSADMIN_TOOL_NAMES.has(name)) return executeSysAdminTool(name, args);
        if (WINDOWS_TOOL_NAMES.has(name)) return executeWindowsTool(name, args, ctx);
        if (UI_TOOL_NAMES.has(name)) return executeUiTool(name, args);
        if (name === 'run_repair') return executeRepairTool(args, ctx, (n, a) => this.dispatch(n, a, ctx));
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }

  private saveNote(summary: string, tags?: string): ToolResult {
    if (!summary.trim()) return { success: false, error: 'Empty summary' };
    const id = saveNoteToDb(summary.trim(), tags, 'ai');
    return { success: true, output: `Saved note #${id}` };
  }

  private async executeCommand(command: string, cwd?: string): Promise<ToolResult> {
    if (!command.trim()) return { success: false, error: 'Empty command' };
    const workDir = cwd && fs.existsSync(cwd) ? cwd : config.assistant.defaultCwd;
    try {
      const { stdout, stderr } = await execAsync(command, {
        shell: 'powershell.exe',
        cwd: workDir,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: childEnv({ POWERSHELL_TELEMETRY_OPTOUT: '1' }),
      });
      return { success: true, stdout: stdout.slice(0, 600), stderr: stderr.slice(0, 300), cwd: workDir };
    } catch (err) {
      const e = err as { message?: string; stdout?: string; stderr?: string; code?: number };
      return {
        success: false,
        error: e.message,
        stdout: (e.stdout || '').slice(0, 600),
        stderr: (e.stderr || '').slice(0, 300),
        exitCode: e.code,
        cwd: workDir,
      };
    }
  }

  private async launchProgram(target: string, argsStr?: string): Promise<ToolResult> {
    if (!target.trim()) return { success: false, error: 'Empty target' };
    return new Promise((resolve) => {
      // `start` handles programs, files and URLs via shell association
      const cmdLine = argsStr ? `start "" "${target}" ${argsStr}` : `start "" "${target}"`;
      const proc = spawn('cmd.exe', ['/c', cmdLine], { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv() });
      proc.on('error', (err) => resolve({ success: false, error: err.message }));
      proc.unref();
      // `start` returns immediately; give it a moment to surface immediate errors
      setTimeout(() => resolve({ success: true, output: `Launched: ${target}${argsStr ? ' ' + argsStr : ''}` }), 500);
    });
  }

  private async searchFiles(
    directory: string,
    namePattern?: string,
    contentPattern?: string,
    maxResults = 50
  ): Promise<ToolResult> {
    if (!fs.existsSync(directory)) return { success: false, error: `Directory not found: ${directory}` };
    const matches: Array<{ path: string; line?: number; preview?: string }> = [];
    const nameRe = namePattern
      ? new RegExp(
          '^' + namePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
          'i'
        )
      : null;
    const nameSub = namePattern && !namePattern.includes('*') ? namePattern.toLowerCase() : null;
    const contentNeedle = contentPattern?.toLowerCase();

    const walk = (dir: string, depth: number): void => {
      if (matches.length >= maxResults || depth > 12) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (matches.length >= maxResults) return;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name)) walk(full, depth + 1);
        } else {
          const nameOk = !namePattern || (nameRe ? nameRe.test(ent.name) : nameSub ? ent.name.toLowerCase().includes(nameSub) : true);
          if (!nameOk) continue;
          if (contentNeedle) {
            try {
              const stat = fs.statSync(full);
              if (stat.size > 2 * 1024 * 1024) continue;
              const text = fs.readFileSync(full, 'utf-8');
              const lines = text.split(/\r?\n/);
              for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                if (lines[i].toLowerCase().includes(contentNeedle)) {
                  matches.push({ path: full, line: i + 1, preview: lines[i].trim().slice(0, 120) });
                }
              }
            } catch {
              /* binary/unreadable — skip */
            }
          } else {
            matches.push({ path: full });
          }
        }
      }
    };
    walk(directory, 0);
    return { success: true, output: JSON.stringify(matches.slice(0, maxResults)), count: matches.length };
  }

  private async readFile(filePath: string, startLine?: number, endLine?: number): Promise<ToolResult> {
    if (!fs.existsSync(filePath)) return { success: false, error: `File not found: ${filePath}` };
    const stat = fs.statSync(filePath);
    if (stat.size > 5 * 1024 * 1024) return { success: false, error: 'File too large (>5MB). Use a line range.' };
    const text = fs.readFileSync(filePath, 'utf-8');
    if (startLine !== undefined || endLine !== undefined) {
      const lines = text.split(/\r?\n/);
      const s = Math.max(1, startLine || 1);
      const e = Math.min(lines.length, endLine || lines.length);
      return { success: true, output: lines.slice(s - 1, e).join('\n').slice(0, 8000), totalLines: lines.length };
    }
    return { success: true, output: text.slice(0, 8000), truncated: text.length > 8000 };
  }

  private async writeFile(filePath: string, content: string): Promise<ToolResult> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, output: `Wrote ${content.length} chars to ${filePath}` };
  }

  private async listDirectory(dirPath: string): Promise<ToolResult> {
    if (!fs.existsSync(dirPath)) return { success: false, error: `Directory not found: ${dirPath}` };
    const entries = fs.readdirSync(dirPath, { withFileTypes: true }).slice(0, 200);
    const list = entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name));
    return { success: true, output: JSON.stringify(list), count: list.length };
  }

  private async deleteFile(filePath: string, recursive: boolean): Promise<ToolResult> {
    if (!fs.existsSync(filePath)) return { success: false, error: `Not found: ${filePath}` };
    fs.rmSync(filePath, { recursive, force: true });
    return { success: true, output: `Deleted: ${filePath}` };
  }

  private async stopProcess(nameOrPid: string): Promise<ToolResult> {
    const isPid = /^\d+$/.test(nameOrPid);
    const cmd = isPid
      ? `Stop-Process -Id ${nameOrPid} -Force`
      : `Stop-Process -Name "${nameOrPid.replace(/"/g, '')}" -Force`;
    return this.executeCommand(cmd);
  }

  private async getSystemInfo(): Promise<ToolResult> {
    const info = {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      totalMemGB: (os.totalmem() / 1073741824).toFixed(1),
      freeMemGB: (os.freemem() / 1073741824).toFixed(1),
      uptimeHours: (os.uptime() / 3600).toFixed(1),
      node: process.version,
      user: os.userInfo().username,
    };
    return { success: true, output: JSON.stringify(info, null, 2) };
  }

  private async delegateToClaudeCode(prompt: string, cwd: string | undefined, ctx: ToolContext): Promise<ToolResult> {
    if (!prompt.trim()) return { success: false, error: 'Empty prompt' };
    const result = await ctx.claudeBridge.run(ctx.chatId, prompt, { cwd, onProgress: ctx.onProgress });
    if (!result.success) {
      return { success: false, error: result.error, output: result.output?.slice(0, 4000), sessionId: result.sessionId };
    }
    return {
      success: true,
      output: result.output.slice(0, 6000),
      sessionId: result.sessionId,
      durationMs: result.durationMs,
    };
  }
}
