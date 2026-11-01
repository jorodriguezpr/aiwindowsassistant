/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * PC health report: one read-only PowerShell pass collects the facts (as a normal user — the
 * admin helper, when installed, adds BitLocker), rules turn them into findings with a score,
 * and the result is a PDF in DOCUMENTS_DIR that the gateway sends to Telegram. Used by
 * /health, the health_report tool and the weekly scheduled run (/health weekly).
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import PDFDocument from 'pdfkit';
import { config, HOSTNAME } from '../config';
import { childEnv } from '../security/SecretStore';
import { callElevated, helperState } from '../elevated/client';

const PS_FACTS = String.raw`$ErrorActionPreference = 'SilentlyContinue'; $ProgressPreference = 'SilentlyContinue'
$o = [ordered]@{}
$os = Get-CimInstance Win32_OperatingSystem
$o.os = "$($os.Caption) $($os.Version)"
$o.uptimeDays = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalDays, 1)
$o.memTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$o.memFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
$o.topMem = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5 | ForEach-Object { "$($_.ProcessName) $([math]::Round($_.WorkingSet64/1MB)) MB" })
$o.drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [ordered]@{ name = $_.DeviceID; sizeGB = [math]::Round($_.Size/1GB); freeGB = [math]::Round($_.FreeSpace/1GB, 1) } })
$o.physicalDisks = @(Get-PhysicalDisk | ForEach-Object { [ordered]@{ name = $_.FriendlyName; health = "$($_.HealthStatus)"; media = "$($_.MediaType)" } })
$o.rebootPending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
$mp = Get-MpComputerStatus
if ($mp) { $o.defender = [ordered]@{ realtime = $mp.RealTimeProtectionEnabled; signatureAgeDays = $mp.AntivirusSignatureAge; quickScanAgeDays = $mp.QuickScanAge; enabled = $mp.AntivirusEnabled } }
$o.firewallOff = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled } | ForEach-Object { $_.Name })
$sess = New-Object -ComObject Microsoft.Update.Session
$h = $sess.CreateUpdateSearcher(); $n = $h.GetTotalHistoryCount()
if ($n -gt 0) { $last = $h.QueryHistory(0, [math]::Min($n, 50)) | Where-Object { $_.ResultCode -eq 2 } | Sort-Object Date -Descending | Select-Object -First 1; if ($last) { $o.lastUpdateDays = [math]::Round(((Get-Date) - $last.Date).TotalDays) } }
$since = (Get-Date).AddDays(-1)
$ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2; StartTime = $since } -MaxEvents 500
$o.systemErrors24h = @($ev).Count
$o.topErrorSources = @($ev | Group-Object ProviderName | Sort-Object Count -Descending | Select-Object -First 4 | ForEach-Object { "$($_.Name) ($($_.Count))" })
$o.unexpectedShutdowns7d = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41; ProviderName = 'Microsoft-Windows-Kernel-Power'; StartTime = (Get-Date).AddDays(-7) }).Count
$o.startupPrograms = @(Get-CimInstance Win32_StartupCommand).Count
$bat = Get-CimInstance Win32_Battery
if ($bat) { $o.battery = [ordered]@{ charge = $bat.EstimatedChargeRemaining; status = $bat.BatteryStatus } }
$o | ConvertTo-Json -Depth 4 -Compress`;

interface Facts {
  os?: string;
  uptimeDays?: number;
  memTotalGB?: number;
  memFreeGB?: number;
  topMem?: string[];
  drives?: { name: string; sizeGB: number; freeGB: number }[];
  physicalDisks?: { name: string; health: string; media: string }[];
  rebootPending?: boolean;
  defender?: { realtime: boolean; signatureAgeDays: number; quickScanAgeDays: number; enabled: boolean };
  firewallOff?: string[];
  lastUpdateDays?: number;
  systemErrors24h?: number;
  topErrorSources?: string[];
  unexpectedShutdowns7d?: number;
  startupPrograms?: number;
  battery?: { charge: number; status: number };
}

export type Severity = 'ok' | 'warn' | 'bad';
export interface Finding {
  area: string;
  severity: Severity;
  text: string;
  fix?: string;
}

function collect(): Promise<Facts> {
  return new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_FACTS], { env: childEnv(), windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      try {
        resolve(JSON.parse(String(out).trim()) as Facts);
      } catch {
        reject(new Error(`health check failed: ${err?.message || 'no data'}`));
      }
    })
  );
}

/** The rules: facts → findings. Exported for tests. */
export function evaluate(f: Facts, bitlocker?: string): Finding[] {
  const out: Finding[] = [];
  const add = (area: string, severity: Severity, text: string, fix?: string) => out.push({ area, severity, text, fix });
  for (const d of f.drives || []) {
    const pct = d.sizeGB ? (d.freeGB / d.sizeGB) * 100 : 100;
    if (pct < 8 || d.freeGB < 10) add('Disk', 'bad', `${d.name} almost full: ${d.freeGB} GB free of ${d.sizeGB} GB`, 'Run /cleanup to see what can be removed');
    else if (pct < 15) add('Disk', 'warn', `${d.name} getting full: ${d.freeGB} GB free of ${d.sizeGB} GB`, 'Run /cleanup');
    else add('Disk', 'ok', `${d.name}: ${d.freeGB} GB free of ${d.sizeGB} GB`);
  }
  for (const p of f.physicalDisks || []) {
    if (p.health && p.health !== 'Healthy') add('Disk health', 'bad', `${p.name} reports "${p.health}"`, 'Back up now and check the drive');
    else add('Disk health', 'ok', `${p.name} (${p.media}): healthy`);
  }
  if (f.rebootPending) add('Restart', 'warn', 'A restart is pending to finish updates', 'Restart Windows when convenient');
  if ((f.uptimeDays ?? 0) > 14) add('Restart', 'warn', `Not restarted for ${f.uptimeDays} days`, 'A restart applies updates and frees memory');
  else if (!f.rebootPending) add('Restart', 'ok', `Up ${f.uptimeDays} days, no restart pending`);
  if (!f.defender) add('Antivirus', 'warn', 'Microsoft Defender status unavailable (another antivirus may be in charge)');
  else {
    if (!f.defender.enabled || !f.defender.realtime) add('Antivirus', 'bad', 'Microsoft Defender real-time protection is OFF', 'Settings → Windows Security');
    if (f.defender.signatureAgeDays > 3) add('Antivirus', 'warn', `Defender signatures are ${f.defender.signatureAgeDays} days old`, 'admin_task defender_update');
    if (f.defender.quickScanAgeDays > 14) add('Antivirus', 'warn', `No quick scan for ${f.defender.quickScanAgeDays} days`, 'admin_task defender_quick_scan');
    if (f.defender.enabled && f.defender.realtime && f.defender.signatureAgeDays <= 3) add('Antivirus', 'ok', 'Defender on and up to date');
  }
  if ((f.firewallOff || []).length) add('Firewall', 'bad', `Firewall OFF for: ${f.firewallOff!.join(', ')}`, 'Settings → Windows Security → Firewall');
  else add('Firewall', 'ok', 'Firewall on for all profiles');
  if (f.lastUpdateDays === undefined) add('Updates', 'warn', 'Could not read the Windows Update history');
  else if (f.lastUpdateDays > 40) add('Updates', 'bad', `Last Windows update installed ${f.lastUpdateDays} days ago`, 'admin_task windows_update_scan / windows_update_install');
  else add('Updates', 'ok', `Last Windows update ${f.lastUpdateDays} days ago`);
  if ((f.unexpectedShutdowns7d ?? 0) > 0) add('Stability', 'warn', `${f.unexpectedShutdowns7d} unexpected shutdown(s)/crash(es) in 7 days`, 'Check power, overheating, drivers');
  if ((f.systemErrors24h ?? 0) > 50) add('Stability', 'warn', `${f.systemErrors24h} system errors in 24 h — top: ${(f.topErrorSources || []).join(', ')}`);
  else add('Stability', 'ok', `${f.systemErrors24h ?? 0} system errors in 24 h`);
  if (f.memTotalGB && f.memFreeGB !== undefined && f.memFreeGB / f.memTotalGB < 0.1)
    add('Memory', 'warn', `Only ${f.memFreeGB} GB of ${f.memTotalGB} GB memory free — biggest: ${(f.topMem || []).slice(0, 3).join(', ')}`);
  else add('Memory', 'ok', `${f.memFreeGB} GB of ${f.memTotalGB} GB free`);
  if ((f.startupPrograms ?? 0) > 15) add('Startup', 'warn', `${f.startupPrograms} programs start with Windows`, 'Settings → Apps → Startup');
  if (bitlocker !== undefined) {
    // bitlocker_status prints a table whose ProtectionStatus column is On / Off per volume
    if (/\bOn\b/.test(bitlocker) && !/\bOff\b/.test(bitlocker)) add('Encryption', 'ok', 'BitLocker protection on');
    else add('Encryption', 'warn', 'BitLocker is off on at least one drive — a lost or stolen PC exposes its files', 'Settings → Privacy & security → Device encryption');
  }
  return out;
}

export function score(findings: Finding[]): number {
  return Math.max(0, 100 - findings.reduce((a, f) => a + (f.severity === 'bad' ? 20 : f.severity === 'warn' ? 7 : 0), 0));
}

function writePdf(file: string, facts: Facts, findings: Finding[], sc: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    const color = sc >= 85 ? '#1a7f37' : sc >= 60 ? '#b26a00' : '#c62828';
    doc.fontSize(20).fillColor('#111').text(`PC health report — ${HOSTNAME}`);
    doc.fontSize(10).fillColor('#555').text(`${new Date().toLocaleString()} · ${facts.os || ''}`);
    doc.moveDown();
    doc.fontSize(28).fillColor(color).text(`${sc}/100`, { continued: true }).fontSize(12).fillColor('#333').text(sc >= 85 ? '   Healthy' : sc >= 60 ? '   Needs attention' : '   Action needed');
    doc.moveDown();
    for (const sev of ['bad', 'warn', 'ok'] as Severity[]) {
      const list = findings.filter((f) => f.severity === sev);
      if (!list.length) continue;
      doc.fontSize(13).fillColor(sev === 'bad' ? '#c62828' : sev === 'warn' ? '#b26a00' : '#1a7f37').text(sev === 'bad' ? 'Action needed' : sev === 'warn' ? 'Worth a look' : 'OK');
      doc.moveDown(0.3);
      for (const f of list) {
        doc.fontSize(10.5).fillColor('#111').text(`• ${f.area}: ${f.text}`, { indent: 8 });
        if (f.fix) doc.fontSize(9.5).fillColor('#555').text(`   → ${f.fix}`, { indent: 18 });
      }
      doc.moveDown(0.6);
    }
    if (facts.topMem?.length) doc.fontSize(9.5).fillColor('#555').text(`Biggest memory users: ${facts.topMem.join(', ')}`);
    doc.fontSize(8.5).fillColor('#888').text('Generated by AiWindowsAssistant — read-only checks, nothing was changed.', 50, doc.page.height - 60);
    doc.end();
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
}

/** The prompt marker of the weekly health report in scheduled tasks (/health weekly). */
export const HEALTH_PROMPT = '@health-report';

export async function buildHealthReport(): Promise<{ pdfPath: string; score: number; summary: string }> {
  const facts = await collect();
  let bitlocker: string | undefined;
  if (helperState().running) {
    const r = await callElevated('bitlocker_status');
    if (r.ok) bitlocker = r.output;
  }
  const findings = evaluate(facts, bitlocker);
  const sc = score(findings);
  fs.mkdirSync(config.assistant.documentsDir, { recursive: true });
  const pdfPath = path.join(config.assistant.documentsDir, `health-${HOSTNAME}-${new Date().toISOString().slice(0, 10)}.pdf`);
  await writePdf(pdfPath, facts, findings, sc);
  const issues = findings.filter((f) => f.severity !== 'ok');
  const summary =
    `🩺 Health ${sc}/100 on ${HOSTNAME}` +
    (issues.length ? `\n${issues.map((f) => `${f.severity === 'bad' ? '🔴' : '🟡'} ${f.area}: ${f.text}${f.fix ? ` → ${f.fix}` : ''}`).join('\n')}` : '\n🟢 Nothing needs attention.') +
    (bitlocker === undefined ? '\n(BitLocker not checked — needs the admin helper)' : '');
  return { pdfPath, score: sc, summary };
}
