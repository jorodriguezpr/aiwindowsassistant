/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * The assistant's side of the elevated helper (helper.ts): queue requests, wait for answers,
 * and install/uninstall the helper (`--install-helper` / `--uninstall-helper`, from an
 * administrator prompt — the only time this app needs one).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { config } from '../config';
import { validateOp } from './ops';
import { HELPER_VERSION } from './helper';

export const HELPER_TASK = 'AiWindowsAssistant Elevated Helper';
const IS_PKG = !!(process as unknown as { pkg?: unknown }).pkg;

export const queueDir = () => path.join(config.dataDir, 'elevated');
/** Admin-only install location of the helper's code. */
const installDir = () => path.join(process.env.ProgramData || 'C:\\ProgramData', 'AiWindowsAssistant', 'helper');

export interface HelperState {
  running: boolean;
  admin: boolean;
  outdated: boolean;
}

export function helperState(): HelperState {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(queueDir(), 'helper.alive.json'), 'utf8')) as { at: number; admin: boolean; version: number };
    const running = Date.now() - a.at < 20_000;
    return { running, admin: running && !!a.admin, outdated: running && a.version !== HELPER_VERSION };
  } catch {
    return { running: false, admin: false, outdated: false };
  }
}

export const HELPER_MISSING =
  'The administrator helper is not running. Install it once from an administrator PowerShell:\n' +
  (IS_PKG ? '  .\\AiWindowsAssistant.exe --install-helper' : `  cd ${config.projectRoot}; npm run install-helper`);

/** Runs one ops.ts job as administrator through the helper. */
export async function callElevated(op: string, rawParam = '', signal?: AbortSignal): Promise<{ ok: boolean; output?: string; error?: string }> {
  const { def, param } = validateOp(op, rawParam);
  const st = helperState();
  if (!st.running) return { ok: false, error: HELPER_MISSING };
  const id = crypto.randomBytes(16).toString('hex');
  const req = path.join(queueDir(), 'requests');
  fs.mkdirSync(req, { recursive: true });
  const tmp = path.join(req, `${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, op, param, at: Date.now() }));
  fs.renameSync(tmp, path.join(req, `${id}.json`));
  const answer = path.join(queueDir(), 'responses', `${id}.json`);
  const deadline = Date.now() + def.timeoutMs + 60_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, error: 'Cancelled — the administrator job itself keeps running in the helper until it finishes' };
    await new Promise((r) => setTimeout(r, 700));
    if (fs.existsSync(answer)) {
      const out = JSON.parse(fs.readFileSync(answer, 'utf8'));
      fs.rmSync(answer, { force: true });
      return out;
    }
  }
  return { ok: false, error: `no answer from the helper after ${Math.round((def.timeoutMs + 60_000) / 60000)} min` };
}

function isAdmin(): boolean {
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** --install-helper: copy the helper to ProgramData (admin-only ACL), register the logon task, start it. */
export function installHelper(): string {
  if (!isAdmin()) throw new Error('Run this from an administrator PowerShell (right-click Start → Terminal (Admin)).');
  const dir = installDir();
  fs.mkdirSync(dir, { recursive: true });
  // only Administrators and SYSTEM may change what runs elevated; users may read/run it
  execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX'], { stdio: 'ignore' });

  let runLine: string;
  if (IS_PKG) {
    const exe = path.join(dir, 'AiWindowsAssistant.exe');
    fs.copyFileSync(process.execPath, exe);
    runLine = `""${exe}"" --elevated-helper ""${queueDir()}""`;
  } else {
    for (const f of ['helper.js', 'ops.js']) fs.copyFileSync(path.join(config.projectRoot, 'dist', 'elevated', f), path.join(dir, f));
    runLine = `""${process.execPath}"" ""${path.join(dir, 'helper.js')}"" ""${queueDir()}""`;
  }
  const vbs = path.join(dir, 'start-helper.vbs');
  fs.writeFileSync(vbs, `' AiWindowsAssistant elevated helper launcher - generated\r\nSet sh = CreateObject("WScript.Shell")\r\nsh.Run "${runLine}", 0, False\r\n`, 'ascii');

  const user = `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || os.userInfo().username}`;
  execFileSync('schtasks', ['/create', '/tn', HELPER_TASK, '/tr', `wscript.exe "${vbs}"`, '/sc', 'onlogon', '/rl', 'highest', '/ru', user, '/it', '/f'], { stdio: 'pipe' });
  try {
    execFileSync('schtasks', ['/end', '/tn', HELPER_TASK], { stdio: 'ignore' });
  } catch {
    /* not running */
  }
  execFileSync('schtasks', ['/run', '/tn', HELPER_TASK], { stdio: 'pipe' });
  return `Installed the administrator helper (${dir}) and started it. It starts by itself at every logon.`;
}

export function uninstallHelper(): string {
  if (!isAdmin()) throw new Error('Run this from an administrator PowerShell.');
  for (const args of [['/end', '/tn', HELPER_TASK], ['/delete', '/tn', HELPER_TASK, '/f']]) {
    try {
      execFileSync('schtasks', args, { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  try {
    const a = JSON.parse(fs.readFileSync(path.join(queueDir(), 'helper.alive.json'), 'utf8')) as { pid: number };
    process.kill(a.pid);
  } catch {
    /* not running */
  }
  fs.rmSync(installDir(), { recursive: true, force: true });
  fs.rmSync(path.join(queueDir(), 'helper.alive.json'), { force: true });
  return 'Removed the administrator helper.';
}
