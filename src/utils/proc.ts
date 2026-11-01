/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Cancellable child processes (1.7.0). Node's own `signal` option only kills the direct child —
 * a PowerShell command that started `ping -t`, Claude Code's Bash/PowerShell tool processes,
 * winget's installer… would keep running. Cancelling here kills the whole process TREE
 * (taskkill /T /F), which is what "stop what the AI is doing" has to mean.
 */

import { exec, execFile, ChildProcess, ExecOptions, ExecFileOptions, execFileSync } from 'child_process';

/** Kill a process and everything it started. */
export function killTree(pid?: number): void {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* already gone */
  }
}

export interface ProcResult {
  stdout: string;
  stderr: string;
  /** error from the child (non-zero exit, timeout) — undefined when it succeeded */
  error?: Error & { code?: number | string | null };
  cancelled?: boolean;
}

function wire(child: ChildProcess, signal: AbortSignal | undefined, onCancel: () => void): () => void {
  if (!signal) return () => undefined;
  const abort = () => {
    onCancel();
    killTree(child.pid);
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

/** exec() through a shell, killable as a tree through `signal`. Never rejects. */
export function execKillable(command: string, opts: ExecOptions, signal?: AbortSignal): Promise<ProcResult> {
  return new Promise((resolve) => {
    let cancelled = false;
    const child = exec(command, { ...opts, encoding: 'utf8' }, (error, stdout, stderr) => {
      unwire();
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), error: error || undefined, cancelled });
    });
    const unwire = wire(child, signal, () => (cancelled = true));
  });
}

/** execFile(), killable as a tree through `signal`. Never rejects. */
export function execFileKillable(file: string, args: string[], opts: ExecFileOptions, signal?: AbortSignal): Promise<ProcResult> {
  return new Promise((resolve) => {
    let cancelled = false;
    const child = execFile(file, args, { ...opts, encoding: 'utf8' }, (error, stdout, stderr) => {
      unwire();
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), error: error || undefined, cancelled });
    });
    const unwire = wire(child, signal, () => (cancelled = true));
  });
}
