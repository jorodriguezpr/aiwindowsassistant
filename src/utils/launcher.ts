/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * How to start this assistant again with extra arguments (--elevated-helper, --toast-action …),
 * both as a dev checkout (node + dist/index.js) and as the pkg single .exe, and a hidden VBS
 * launcher for it — node/pkg executables are console programs, so starting them directly from
 * Task Scheduler or a toast button would flash a black window.
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

const IS_PKG = !!(process as unknown as { pkg?: unknown }).pkg;

/** [executable, ...arguments] that run this assistant with `args`. */
export function selfCommand(args: string[]): string[] {
  return IS_PKG ? [process.execPath, ...args] : [process.execPath, path.join(config.projectRoot, 'dist', 'index.js'), ...args];
}

/**
 * The command Claude Code runs as a PreToolUse hook. Installed .exe: the exe itself
 * (`--hook-approval` / `--hook-readonly`, no Node.js needed); dev checkout: node + the wrapper.
 */
export function hookCommand(kind: 'approval' | 'readonly'): string {
  if (IS_PKG) return `"${process.execPath}" --hook-${kind}`;
  return `node "${path.join(config.projectRoot, 'scripts', `claude-${kind}-hook.js`)}"`;
}

const vbsQuote =(s: string) => `""${s.replace(/"/g, '')}""`;

/**
 * Writes data/<name>.vbs that runs this assistant hidden with `args`, plus whatever arguments
 * the VBS itself receives (quotes stripped, so a crafted URL can't add switches). Returns its path.
 */
export function writeHiddenSelfLauncher(name: string, args: string[]): string {
  const [exe, ...rest] = selfCommand(args);
  const fixed = [exe, ...rest].map(vbsQuote).join(' ');
  const vbs = [
    `' AiWindowsAssistant hidden launcher (${name}) - generated, do not edit`,
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${config.projectRoot}"`,
    'a = ""',
    'For Each x In WScript.Arguments',
    '  a = a & " """ & Replace(x, """", "") & """"',
    'Next',
    `sh.Run "${fixed}" & a, 0, False`,
    '',
  ].join('\r\n');
  const file = path.join(config.dataDir, `${name}.vbs`);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, vbs, 'ascii');
  return file;
}
