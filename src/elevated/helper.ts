/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * The elevated helper: a small process Task Scheduler starts at logon "with highest privileges",
 * so the assistant (which runs as a normal user) can do the handful of admin jobs in ops.ts —
 * install Windows updates, BitLocker status, restore points… — without a UAC prompt nobody is
 * there to click.
 *
 * Standalone on purpose (node built-ins + ops.ts only, no config/.env/database): `--install-helper`
 * copies these two files into %ProgramData%\AiWindowsAssistant\helper with an ACL only
 * administrators can write. Starting code from the user-writable project folder with admin
 * rights would let any program running as the user edit it and get admin at the next logon.
 *
 * Requests: <queue>\requests\<id>.json {id, op, param, at} written by the assistant; answers:
 * <queue>\responses\<id>.json {ok, output|error}. The queue IS user-writable, so everything in a
 * request is treated as untrusted: only ops.ts names, validated parameters, requests older than
 * 2 minutes ignored, and the script goes to PowerShell in memory (-EncodedCommand) with the
 * parameter as base64 data — no script file that could be swapped between write and run.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { validateOp } from './ops';

export const HELPER_VERSION = 1;
const MAX_AGE_MS = 120_000;

function isAdmin(): boolean {
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function runPowerShell(script: string, param: string, timeoutMs: number): Promise<{ ok: boolean; output?: string; error?: string }> {
  const full = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$P = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(param, 'utf8').toString('base64')}'))
${script}`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (err) resolve({ ok: false, error: (String(stderr || '').trim() || err.message).slice(0, 3000), output: out.slice(0, 3000) });
        else resolve({ ok: true, output: out.slice(0, 6000) || 'Done.' });
      }
    );
  });
}

export async function runElevatedHelper(queueDir: string): Promise<void> {
  const reqDir = path.join(queueDir, 'requests');
  const resDir = path.join(queueDir, 'responses');
  const logFile = path.join(queueDir, 'helper.log');
  const log = (msg: string) => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\r\n`);
    } catch {
      /* ignore */
    }
  };
  fs.mkdirSync(reqDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });

  const admin = isAdmin();
  const aliveFile = path.join(queueDir, 'helper.alive.json');
  const beat = () => {
    try {
      fs.writeFileSync(aliveFile, JSON.stringify({ at: Date.now(), pid: process.pid, admin, version: HELPER_VERSION }));
    } catch {
      /* ignore */
    }
  };
  // one helper at a time: another live one keeps its heartbeat fresh
  try {
    const other = JSON.parse(fs.readFileSync(aliveFile, 'utf8')) as { at: number; pid: number };
    if (other.pid !== process.pid && Date.now() - other.at < 15_000) {
      try {
        process.kill(other.pid, 0);
        log(`another helper (pid ${other.pid}) is running — exiting`);
        return;
      } catch {
        /* it's gone */
      }
    }
  } catch {
    /* no heartbeat yet */
  }
  log(`helper v${HELPER_VERSION} started, pid ${process.pid}, administrator: ${admin}`);
  beat();
  setInterval(beat, 5000);

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const f of fs.readdirSync(reqDir).filter((n) => /^[a-f0-9]{16,64}\.json$/.test(n))) {
        const file = path.join(reqDir, f);
        let req: { id?: string; op?: string; param?: string; at?: number };
        try {
          req = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          req = {};
        }
        try {
          fs.unlinkSync(file);
        } catch {
          continue; // someone else took it
        }
        const id = f.replace(/\.json$/, '');
        const answer = async () => {
          if (req.id !== id) return { ok: false, error: 'malformed request' };
          if (typeof req.at !== 'number' || Date.now() - req.at > MAX_AGE_MS) return { ok: false, error: 'request too old — ignored' };
          if (!admin) return { ok: false, error: 'the helper is not running as administrator (re-run --install-helper from an administrator prompt)' };
          const { def, param } = validateOp(String(req.op || ''), String(req.param || ''));
          log(`run ${req.op}${param ? ` (${param})` : ''}`);
          const r = await runPowerShell(def.script, param, def.timeoutMs);
          log(`done ${req.op}: ${r.ok ? 'ok' : 'failed'}`);
          return r;
        };
        let result: { ok: boolean; output?: string; error?: string };
        try {
          result = await answer();
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const tmp = path.join(resDir, `${id}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(result));
        fs.renameSync(tmp, path.join(resDir, `${id}.json`));
      }
      // answers nobody collected (the assistant restarted): drop after an hour
      for (const f of fs.readdirSync(resDir)) {
        const p = path.join(resDir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { force: true });
      }
    } catch (err) {
      log(`queue error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  };
  setInterval(() => void tick(), 1000);
}

// started directly: node helper.js <queueDir>
if (require.main === module) {
  const queue = process.argv[2];
  if (!queue) {
    console.error('usage: helper.js <queueDir>');
    process.exit(1);
  }
  void runElevatedHelper(queue);
}
