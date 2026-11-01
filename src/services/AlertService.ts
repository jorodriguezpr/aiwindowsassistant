/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Proactive alerts (1.5.0): every ALERT_INTERVAL_MINUTES a read-only PowerShell pass — no AI —
 * looks for things the owner should hear about without asking, and tells them in Telegram and
 * as a Windows notification:
 *   • system drive almost full · Microsoft Defender detections · unexpected shutdowns/crashes
 *   • a disk reporting a problem · a restart pending for days
 *   • NEW programs set to start with Windows, NEW services, NEW scheduled tasks — the usual
 *     footprints of malware or unwanted software (compared with a baseline taken on first run)
 * Each condition is repeated at most once a day; new-item alerts once per item. State in
 * data/alerts.json. /alerts shows the state, /alerts off|on, /alerts reset (new baseline).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { config } from '../config';
import { childEnv } from '../security/SecretStore';
import type { Logger } from '../logger';

const PS_SNAPSHOT = String.raw`$ErrorActionPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue'
$since = [datetime]::Parse($env:AIWA_SINCE)
$o = [ordered]@{}
$sys = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
$o.systemDrive = $env:SystemDrive; $o.freeGB = [math]::Round($sys.FreeSpace/1GB, 1); $o.sizeGB = [math]::Round($sys.Size/1GB)
$o.detections = @(Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -gt $since } | ForEach-Object { "$((Get-MpThreat -ThreatID $_.ThreatID).ThreatName) in $($_.Resources -join ', ')" })
$o.crashes = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41; ProviderName = 'Microsoft-Windows-Kernel-Power'; StartTime = $since }).Count
$o.badDisks = @(Get-PhysicalDisk | Where-Object { $_.HealthStatus -ne 'Healthy' } | ForEach-Object { "$($_.FriendlyName): $($_.HealthStatus)" })
$o.rebootPending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
$o.uptimeDays = [math]::Round(((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalDays, 1)
$T = [char]9
$o.startup = @(Get-CimInstance Win32_StartupCommand | ForEach-Object { "$($_.Name) ($($_.Location))$T$($_.Command)" })
$o.services = @(Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' } | ForEach-Object { "$($_.Name)$T$($_.DisplayName): $($_.PathName)" })
$o.tasks = @(Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft\*' -and $_.TaskName -notlike 'AiWindowsAssistant*' } | ForEach-Object { "$($_.TaskPath)$($_.TaskName)$T$(($_.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }) -join '; ')" })
$o | ConvertTo-Json -Depth 3 -Compress`;

interface Snapshot {
  systemDrive: string;
  freeGB: number;
  sizeGB: number;
  detections: string[];
  crashes: number;
  badDisks: string[];
  rebootPending: boolean;
  uptimeDays: number;
  startup: string[];
  services: string[];
  tasks: string[];
}

interface State {
  enabled: boolean;
  lastCheck?: string;
  /** condition key -> last time it was reported (ms) */
  lastSent: Record<string, number>;
  baseline?: { startup: string[]; services: string[]; tasks: string[] };
}

export interface Alert {
  key: string;
  text: string;
}

const DAY = 86_400_000;
const STATE_FILE = () => path.join(config.dataDir, 'alerts.json');

function load(): State {
  try {
    return { lastSent: {}, ...JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) } as State;
  } catch {
    return { enabled: config.alerts.enabled, lastSent: {} };
  }
}
const save = (s: State) => fs.writeFileSync(STATE_FILE(), JSON.stringify(s, null, 1));

function snapshot(since: Date): Promise<Snapshot> {
  return new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SNAPSHOT], { env: childEnv({ AIWA_SINCE: since.toISOString() }), windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      try {
        const s = JSON.parse(String(out).trim()) as Snapshot;
        for (const k of ['detections', 'badDisks', 'startup', 'services', 'tasks'] as const) s[k] = Array.isArray(s[k]) ? s[k] : s[k] ? [String(s[k])] : [];
        resolve(s);
      } catch {
        reject(new Error(`alert check failed: ${err?.message || 'no data'}`));
      }
    })
  );
}

const keyOf = (x: string) => x.split('\t')[0];

/** Which alerts a snapshot raises against the baseline. Pure — exported for tests. */
export function findAlerts(s: Snapshot, baseline: NonNullable<State['baseline']>): Alert[] {
  const out: Alert[] = [];
  const pct = s.sizeGB ? (s.freeGB / s.sizeGB) * 100 : 100;
  if (pct < 8 || s.freeGB < 8) out.push({ key: 'disk-full', text: `💽 ${s.systemDrive} is almost full: ${s.freeGB} GB free. /cleanup shows what can go.` });
  for (const d of s.detections) out.push({ key: `defender:${d}`, text: `🛡 Microsoft Defender found a threat: ${d}` });
  if (s.crashes > 0) out.push({ key: 'crash', text: `💥 The PC shut down unexpectedly (crash or power loss) ${s.crashes} time(s) since the last check.` });
  for (const d of s.badDisks) out.push({ key: `disk-health:${d}`, text: `⚠️ A disk reports a problem — ${d}. Back up now.` });
  if (s.rebootPending && s.uptimeDays > 3) out.push({ key: 'reboot-pending', text: `🔄 Windows has been waiting ${Math.floor(s.uptimeDays)} days for a restart to finish updates.` });
  // items are "name<TAB>detail": compared by name only, so an app update that moves its exe
  // (Edge's path carries its version) is not "new"
  const fresh = (now: string[], before: string[]) => {
    const known = new Set(before.map(keyOf));
    return now.filter((x) => !known.has(keyOf(x)));
  };
  const show = (x: string) => x.replace('\t', ' — ');
  for (const x of fresh(s.startup, baseline.startup)) out.push({ key: `startup:${keyOf(x)}`, text: `🆕 New program starts with Windows: ${show(x)}\nIf you didn't install anything, check it.` });
  for (const x of fresh(s.services, baseline.services)) out.push({ key: `service:${keyOf(x)}`, text: `🆕 New automatic service: ${show(x)}\nIf you didn't install anything, check it.` });
  for (const x of fresh(s.tasks, baseline.tasks)) out.push({ key: `task:${keyOf(x)}`, text: `🆕 New scheduled task: ${show(x)}\nIf you didn't set it up, check it.` });
  return out;
}

export class AlertService {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private notify: (text: string) => Promise<void>, private logger?: Logger) {}

  start(): void {
    if (!load().enabled) return;
    const every = Math.max(2, config.alerts.intervalMinutes) * 60_000;
    setTimeout(() => void this.check(), 60_000); // first look a minute after start
    this.timer = setInterval(() => void this.check(), every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  setEnabled(on: boolean): void {
    const s = load();
    s.enabled = on;
    save(s);
    if (on && !this.timer) this.start();
    if (!on) this.stop();
  }

  /** New baseline: what is installed now counts as known. */
  async reset(): Promise<number> {
    const s = load();
    const snap = await snapshot(new Date());
    s.baseline = { startup: snap.startup, services: snap.services, tasks: snap.tasks };
    s.lastSent = {};
    save(s);
    return snap.startup.length + snap.services.length + snap.tasks.length;
  }

  status(): string {
    const s = load();
    return (
      `🔔 Alerts: ${s.enabled ? `on, every ${config.alerts.intervalMinutes} min` : 'off'}\n` +
      `Last check: ${s.lastCheck ? new Date(s.lastCheck).toLocaleString() : 'not yet'}\n` +
      `Watching: ${s.baseline ? `${s.baseline.startup.length} startup programs, ${s.baseline.services.length} automatic services, ${s.baseline.tasks.length} scheduled tasks` : 'baseline is taken at the first check'}\n` +
      `/alerts off · /alerts on · /alerts reset (accept what is installed now) · /alerts check`
    );
  }

  /** One pass. Returns the alerts sent. */
  async check(): Promise<Alert[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const s = load();
      const since = s.lastCheck ? new Date(s.lastCheck) : new Date(Date.now() - 3600_000);
      const snap = await snapshot(since);
      if (!s.baseline) {
        // first run: everything already there is "known" — only later changes are news
        s.baseline = { startup: snap.startup, services: snap.services, tasks: snap.tasks };
        s.lastCheck = new Date().toISOString();
        save(s);
        return [];
      }
      const now = Date.now();
      const sent: Alert[] = [];
      for (const a of findAlerts(snap, s.baseline)) {
        const once = /^(startup|service|task|defender):/.test(a.key); // per item: once ever
        const last = s.lastSent[a.key];
        if (last && (once || now - last < DAY)) continue;
        s.lastSent[a.key] = now;
        sent.push(a);
      }
      // new items become part of the baseline once reported
      const merge = (a: string[], b: string[]) => [...new Map([...a, ...b].map((x) => [keyOf(x), x] as [string, string])).values()];
      s.baseline = { startup: merge(s.baseline.startup, snap.startup), services: merge(s.baseline.services, snap.services), tasks: merge(s.baseline.tasks, snap.tasks) };
      s.lastCheck = new Date().toISOString();
      save(s);
      for (const a of sent) await this.notify(a.text).catch(() => undefined);
      return sent;
    } catch (err) {
      this.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, 'alert check failed');
      return [];
    } finally {
      this.running = false;
    }
  }
}
