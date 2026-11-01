/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Disk clean-up: measure what can go (analyzeDiskSpace — changes nothing), then clean the
 * targets the owner picked (cleanUpDisk — the tool is approval-gated). Only caches and
 * temporary files are deleted for good; old installers in Downloads go to the Recycle Bin.
 * Files in use are skipped, as are temp items touched in the last 24 hours (a running program
 * may still need them) and Claude Code's own temp folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { childEnv } from '../security/SecretStore';
import { callElevated, helperState } from '../elevated/client';

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DAY = 86_400_000;
const KEEP_IN_TEMP = new Set(['claude', 'aiwa-shots', 'aiwa-photos']);

function sizeOf(p: string, deadline: number): number {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    if (Date.now() > deadline) break; // huge folders: a lower bound is good enough
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) total += st.size;
    else if (st.isDirectory()) {
      try {
        for (const n of fs.readdirSync(cur)) stack.push(path.join(cur, n));
      } catch {
        /* no access */
      }
    }
  }
  return total;
}

function entries(dir: string, filter: (full: string, st: fs.Stats) => boolean = () => true): string[] {
  try {
    return fs
      .readdirSync(dir)
      .map((n) => path.join(dir, n))
      .filter((full) => {
        try {
          return filter(full, fs.lstatSync(full));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function browserCacheDirs(): string[] {
  const roots = [path.join(LOCAL, 'Google', 'Chrome', 'User Data'), path.join(LOCAL, 'Microsoft', 'Edge', 'User Data'), path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')];
  const out: string[] = [];
  for (const root of roots)
    for (const prof of entries(root, (_f, st) => st.isDirectory()))
      for (const c of ['Cache', 'Code Cache', 'GPUCache']) if (fs.existsSync(path.join(prof, c))) out.push(path.join(prof, c));
  return out;
}

function oldInstallers(): string[] {
  return entries(path.join(os.homedir(), 'Downloads'), (f, st) => st.isFile() && /\.(exe|msi|msix|msixbundle|iso)$/i.test(f) && Date.now() - st.mtimeMs > 60 * DAY);
}

function run(file: string, args: string[], timeout = 600000): Promise<string> {
  return new Promise((resolve) => execFile(file, args, { env: childEnv(), windowsHide: true, timeout, shell: /\.cmd$/i.test(file) }, (_e, out, err) => resolve(`${out || ''}${err || ''}`)));
}

function ps(script: string, timeout = 600000): Promise<string> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeout);
}

interface Target {
  id: string;
  label: string;
  /** what "clean" does, for the approval message */
  how: string;
  /** included in "all-safe" */
  safe: boolean;
  measure: (deadline: number) => Promise<number>;
  clean: () => Promise<void>;
}

const removeAll = (paths: string[]) => {
  for (const p of paths) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 0 });
    } catch {
      /* in use: skip */
    }
  }
};
const sum = (paths: string[], deadline: number) => paths.reduce((a, p) => a + sizeOf(p, deadline), 0);
const tempItems = () => entries(os.tmpdir(), (f, st) => !KEEP_IN_TEMP.has(path.basename(f).toLowerCase()) && Date.now() - st.mtimeMs > DAY);

export const CLEANUP_TARGETS: Target[] = [
  { id: 'temp', label: 'Temporary files (yours)', how: 'deleted (items older than 1 day, files in use skipped)', safe: true,
    measure: async (d) => sum(tempItems(), d), clean: async () => removeAll(tempItems()) },
  { id: 'browser_cache', label: 'Browser caches (Chrome, Edge, Brave)', how: 'deleted — sites load a bit slower the first time; logins are kept', safe: true,
    measure: async (d) => sum(browserCacheDirs(), d), clean: async () => removeAll(browserCacheDirs().flatMap((c) => entries(c))) },
  { id: 'npm_cache', label: 'npm package cache', how: 'emptied (npm cache clean --force)', safe: true,
    measure: async (d) => sizeOf(path.join(LOCAL, 'npm-cache'), d), clean: async () => void (await run('npm.cmd', ['cache', 'clean', '--force'])) },
  { id: 'pip_cache', label: 'pip package cache', how: 'emptied', safe: true,
    measure: async (d) => sizeOf(path.join(LOCAL, 'pip', 'cache'), d), clean: async () => removeAll(entries(path.join(LOCAL, 'pip', 'cache'))) },
  { id: 'crash_dumps', label: 'Crash dumps and error reports', how: 'deleted', safe: true,
    measure: async (d) => sum([path.join(LOCAL, 'CrashDumps'), path.join(LOCAL, 'Microsoft', 'Windows', 'WER')], d),
    clean: async () => removeAll([...entries(path.join(LOCAL, 'CrashDumps')), ...entries(path.join(LOCAL, 'Microsoft', 'Windows', 'WER'))]) },
  { id: 'vscode_cache', label: 'VS Code extension installers and crash reports', how: 'deleted', safe: true,
    measure: async (d) => sum([path.join(ROAMING, 'Code', 'CachedExtensionVSIXs'), path.join(ROAMING, 'Code', 'Crashpad')], d),
    clean: async () => removeAll([...entries(path.join(ROAMING, 'Code', 'CachedExtensionVSIXs')), ...entries(path.join(ROAMING, 'Code', 'Crashpad'))]) },
  { id: 'recycle_bin', label: 'Recycle Bin', how: 'emptied — PERMANENT', safe: false,
    measure: async () => Number((await ps(`$s=(New-Object -ComObject Shell.Application).Namespace(10); ($s.Items() | Measure-Object -Property Size -Sum).Sum`, 120000)).trim()) || 0,
    clean: async () => void (await ps('Clear-RecycleBin -Force -ErrorAction SilentlyContinue')) },
  { id: 'old_installers', label: 'Installers in Downloads older than 60 days (.exe .msi .iso)', how: 'moved to the Recycle Bin (frees the space once the bin is emptied)', safe: false,
    measure: async (d) => sum(oldInstallers(), d),
    clean: async () => {
      const files = oldInstallers();
      if (!files.length) return;
      const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(',');
      await ps(`Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($f in @(${list})) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f, 'OnlyErrorDialogs', 'SendToRecycleBin') }`);
    } },
  { id: 'windows_system', label: 'Windows temp, Windows Update download cache, Delivery Optimization cache (needs the admin helper)', how: 'deleted by the administrator helper', safe: false,
    measure: async (d) => sum([path.join(process.env.windir || 'C:\\Windows', 'SoftwareDistribution', 'Download'), path.join(process.env.windir || 'C:\\Windows', 'Temp')], d),
    clean: async () => {
      const r = await callElevated('system_cleanup');
      if (!r.ok) throw new Error(r.error || 'system clean-up failed');
    } },
];

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
const mbOrGb = (n: number) => (n >= 1024 ** 3 ? gb(n) : `${Math.round(n / 1024 ** 2)} MB`);

async function freeSpace(): Promise<number> {
  const drive = (process.env.SystemDrive || 'C:').replace(':', '');
  return Number((await ps(`(Get-PSDrive ${drive}).Free`, 30000)).trim()) || 0;
}

export async function analyzeDiskSpace(): Promise<string> {
  const deadline = Date.now() + 90_000;
  const free = await freeSpace();
  const lines: string[] = [];
  let total = 0;
  for (const t of CLEANUP_TARGETS) {
    const n = await t.measure(deadline);
    if (t.id === 'windows_system' && !helperState().running) {
      lines.push(`• ${t.id} — ${t.label}: ~${mbOrGb(n)} (install the admin helper to clean it)`);
      continue;
    }
    total += n;
    lines.push(`• ${t.id} — ${t.label}: ${mbOrGb(n)}${t.safe ? '' : ' (not in all-safe)'}`);
  }
  const sys = process.env.SystemDrive || 'C:';
  // Node gets EPERM on these two; the folder listing still knows their size
  const big: string[] = [];
  const hints: Record<string, string> = { 'hiberfil.sys': '/admin hibernation_reduced shrinks it', 'pagefile.sys': '/admin pagefile_fixed <MB> sets a fixed size' };
  const listed = await ps(`Get-ChildItem '${sys}\\' -Force -File -Filter *.sys | ForEach-Object { "$($_.Name)=$($_.Length)" }`, 30000);
  for (const line of listed.split(/\r?\n/)) {
    const [name, bytes] = line.trim().split('=');
    if (hints[name?.toLowerCase()] && Number(bytes) > 0) big.push(`• ${name}: ${gb(Number(bytes))} — ${hints[name.toLowerCase()]}`);
  }
  return (
    `💽 ${sys} free: ${gb(free)}\n\nCan be cleaned (about ${gb(total)}):\n${lines.join('\n')}` +
    (big.length ? `\n\nSystem files:\n${big.join('\n')}` : '') +
    `\n\nTo clean: /cleanup run all-safe — or name targets, e.g. /cleanup run temp,npm_cache`
  );
}

/** `targets`: comma-separated ids or "all-safe". */
export function parseTargets(targets: string): Target[] {
  const want = targets.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (want.includes('all-safe') || want.includes('all')) return CLEANUP_TARGETS.filter((t) => t.safe || (want.includes('all') && t.id !== 'recycle_bin'));
  const picked = CLEANUP_TARGETS.filter((t) => want.includes(t.id));
  const unknown = want.filter((w) => !CLEANUP_TARGETS.some((t) => t.id === w));
  if (unknown.length) throw new Error(`Unknown clean-up target(s): ${unknown.join(', ')}. Known: ${CLEANUP_TARGETS.map((t) => t.id).join(', ')}`);
  return picked;
}

export function describeTargets(targets: string): string {
  try {
    return parseTargets(targets).map((t) => `• ${t.label}: ${t.how}`).join('\n');
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function cleanUpDisk(targets: string): Promise<string> {
  const picked = parseTargets(targets);
  if (!picked.length) return 'Nothing selected.';
  const before = await freeSpace();
  const done: string[] = [];
  for (const t of picked) {
    try {
      await t.clean();
      done.push(`✅ ${t.label}`);
    } catch (err) {
      done.push(`❌ ${t.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const after = await freeSpace();
  return `${done.join('\n')}\n\nFreed ${gb(Math.max(0, after - before))} — ${process.env.SystemDrive || 'C:'} now has ${gb(after)} free.`;
}
