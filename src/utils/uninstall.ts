/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * `AiWindowsAssistant.exe --uninstall-cleanup`, run by the Windows uninstaller: removes what the
 * app registered for the user at runtime — the "start with Windows" entry, the aiwa: link type
 * and notification registration, /schedule tasks. Each one is removed ONLY when it points at
 * THIS install folder, so uninstalling one copy never breaks another (e.g. a dev checkout using
 * the same names). The administrator helper is removed separately (--uninstall-helper, elevated).
 */

import { execFileSync } from 'child_process';
import { config } from '../config';

const ours = (s: string) => s.toLowerCase().includes(config.projectRoot.toLowerCase());

function regValue(key: string, value?: string): string {
  try {
    return execFileSync('reg', ['query', key, ...(value ? ['/v', value] : ['/ve'])], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString();
  } catch {
    return '';
  }
}

function regDelete(args: string[]): boolean {
  try {
    execFileSync('reg', ['delete', ...args, '/f'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function uninstallCleanup(): string[] {
  const done: string[] = [];
  const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  if (ours(regValue(RUN, 'AiWindowsAssistant')) && regDelete([RUN, '/v', 'AiWindowsAssistant'])) done.push('start with Windows');

  if (ours(regValue('HKCU\\Software\\Classes\\aiwa\\shell\\open\\command'))) {
    if (regDelete(['HKCU\\Software\\Classes\\aiwa'])) done.push('aiwa: links');
    if (regDelete(['HKCU\\Software\\Classes\\AppUserModelId\\AiWindowsAssistant'])) done.push('notifications');
  }

  // /schedule tasks: "AiWindowsAssistant-<id>" whose action runs this install
  try {
    const csv = execFileSync('schtasks', ['/query', '/fo', 'csv', '/v'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).toString();
    const names = new Set<string>();
    for (const line of csv.split(/\r?\n/)) {
      const cols = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1)) || [];
      const name = cols.find((c) => /^\\AiWindowsAssistant-\d+$/.test(c));
      if (name && cols.some((c) => ours(c))) names.add(name);
    }
    for (const n of names) {
      try {
        execFileSync('schtasks', ['/delete', '/tn', n, '/f'], { stdio: 'ignore', windowsHide: true });
        done.push(`scheduled task ${n.slice(1)}`);
      } catch {
        /* gone */
      }
    }
  } catch {
    /* schtasks unavailable */
  }
  return done;
}
