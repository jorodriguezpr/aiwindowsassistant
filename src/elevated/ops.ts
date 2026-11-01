/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * The ONLY things the elevated helper will do. Each op is a fixed PowerShell script; the few
 * parameters are validated here (service names from a list, a page-file size range, a winget
 * package id pattern) and passed as base64 data, never pasted into the script — so whoever can
 * drop a request in the helper's queue can at most run one of these, never arbitrary code as
 * administrator.
 *
 * risk: 'read' — only looks; 'safe' — changes something but harmless/reversible (signature
 * update, quick scan, restore point); 'change' — needs the owner's approval in Telegram first.
 */

export type OpRisk = 'read' | 'safe' | 'change';

export interface ElevatedOp {
  title: string;
  risk: OpRisk;
  timeoutMs: number;
  /** Validates and normalizes the parameter; throws with a user-facing message when invalid. */
  param?: (raw: string) => string;
  paramHelp?: string;
  /** PowerShell; the validated parameter is in $P. */
  script: string;
}

export const SERVICE_ALLOWLIST = ['Spooler', 'wuauserv', 'BITS', 'WSearch', 'Audiosrv', 'AudioEndpointBuilder', 'Dnscache', 'W32Time', 'WlanSvc', 'bthserv', 'Themes', 'TabletInputService', 'StiSvc'];

const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{1,99}$/;

export const ELEVATED_OPS: Record<string, ElevatedOp> = {
  status: {
    title: 'Helper status',
    risk: 'read',
    timeoutMs: 30_000,
    script: `$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
"Running as $($id.Name), administrator: $admin"`,
  },
  bitlocker_status: {
    title: 'BitLocker status',
    risk: 'read',
    timeoutMs: 60_000,
    script: `Get-BitLockerVolume | Select-Object MountPoint, VolumeStatus, ProtectionStatus, EncryptionPercentage, @{n='KeyProtectors';e={($_.KeyProtector.KeyProtectorType) -join ', '}} | Format-Table -AutoSize | Out-String -Width 200`,
  },
  windows_update_scan: {
    title: 'Check for Windows updates',
    risk: 'read',
    timeoutMs: 15 * 60_000,
    script: `$s = New-Object -ComObject Microsoft.Update.Session
$r = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
if ($r.Updates.Count -eq 0) { 'No pending Windows updates.' } else {
  "$($r.Updates.Count) update(s) available:"
  foreach ($u in $r.Updates) { "- $($u.Title)  ($([math]::Round($u.MaxDownloadSize/1MB)) MB)" }
}
$reboot = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending')
if ($reboot) { 'A restart is pending to finish earlier updates.' }`,
  },
  windows_update_install: {
    title: 'Install Windows updates',
    risk: 'change',
    timeoutMs: 3 * 3600_000,
    script: `$s = New-Object -ComObject Microsoft.Update.Session
$r = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
if ($r.Updates.Count -eq 0) { 'No pending Windows updates.'; return }
$todo = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $r.Updates) { if (-not $u.EulaAccepted) { $u.AcceptEula() }; [void]$todo.Add($u) }
$d = $s.CreateUpdateDownloader(); $d.Updates = $todo; [void]$d.Download()
$i = $s.CreateUpdateInstaller(); $i.Updates = $todo; $res = $i.Install()
for ($k = 0; $k -lt $todo.Count; $k++) { $c = $res.GetUpdateResult($k).ResultCode; "- $($todo.Item($k).Title): $(@('not started','in progress','installed','installed with errors','failed','aborted')[$c])" }
if ($res.RebootRequired) { 'A restart is needed to finish.' }`,
  },
  defender_update: {
    title: 'Update Microsoft Defender signatures',
    risk: 'safe',
    timeoutMs: 10 * 60_000,
    script: `Update-MpSignature; $m = Get-MpComputerStatus; "Defender signatures: $($m.AntivirusSignatureVersion), updated $($m.AntivirusSignatureLastUpdated)"`,
  },
  defender_quick_scan: {
    title: 'Microsoft Defender quick scan',
    risk: 'safe',
    timeoutMs: 60 * 60_000,
    script: `Start-MpScan -ScanType QuickScan
$t = Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -gt (Get-Date).AddHours(-2) }
if ($t) { "Threats found:"; $t | ForEach-Object { "- $($_.ThreatID) $($_.Resources -join ', ')" } } else { 'Quick scan finished: no threats found.' }`,
  },
  restore_point: {
    title: 'Create a System Restore point',
    risk: 'safe',
    timeoutMs: 10 * 60_000,
    script: `Enable-ComputerRestore -Drive "$env:SystemDrive\\" -ErrorAction SilentlyContinue
Checkpoint-Computer -Description 'AiWindowsAssistant' -RestorePointType MODIFY_SETTINGS -WarningVariable w
if ($w) { "Not created: $w" } else { $p = Get-ComputerRestorePoint | Select-Object -Last 1; "Restore point created: $($p.Description) #$($p.SequenceNumber)" }`,
  },
  restart_service: {
    title: 'Restart a Windows service',
    risk: 'change',
    timeoutMs: 2 * 60_000,
    paramHelp: SERVICE_ALLOWLIST.join(', '),
    param: (raw) => {
      const hit = SERVICE_ALLOWLIST.find((s) => s.toLowerCase() === raw.trim().toLowerCase());
      if (!hit) throw new Error(`Only these services can be restarted: ${SERVICE_ALLOWLIST.join(', ')}`);
      return hit;
    },
    script: `Restart-Service -Name $P -Force; $s = Get-Service -Name $P; "$($s.DisplayName): $($s.Status)"`,
  },
  hibernation_reduced: {
    title: 'Shrink the hibernation file (keeps Sleep and Fast Startup)',
    risk: 'change',
    timeoutMs: 60_000,
    script: `powercfg /h /type reduced; if ($LASTEXITCODE -ne 0) { throw "powercfg failed ($LASTEXITCODE)" }
$f = Get-Item "$env:SystemDrive\\hiberfil.sys" -Force -ErrorAction SilentlyContinue
"Hibernation file: reduced$(if ($f) { ', now ' + [math]::Round($f.Length/1GB,1) + ' GB' })"`,
  },
  pagefile_fixed: {
    title: 'Set a fixed page file size (takes effect after a restart)',
    risk: 'change',
    timeoutMs: 60_000,
    paramHelp: 'size in MB, 2048-65536 (e.g. 16384)',
    param: (raw) => {
      const n = Number(raw.trim());
      if (!Number.isInteger(n) || n < 2048 || n > 65536) throw new Error('Page file size must be a whole number of MB between 2048 and 65536');
      return String(n);
    },
    script: `$mb = [int]$P
$cs = Get-CimInstance Win32_ComputerSystem
Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false }
$pf = Get-CimInstance Win32_PageFileSetting -Filter "Name='$($env:SystemDrive)\\\\pagefile.sys'"
if (-not $pf) { $pf = New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = "$env:SystemDrive\\pagefile.sys" } }
Set-CimInstance -InputObject $pf -Property @{ InitialSize = $mb; MaximumSize = $mb }
"Page file set to $mb MB (fixed). Restart Windows for it to take effect."`,
  },
  system_cleanup: {
    title: 'Clean Windows temp files, the Windows Update download cache and the Delivery Optimization cache',
    risk: 'change',
    timeoutMs: 30 * 60_000,
    script: `$before = (Get-PSDrive ($env:SystemDrive.TrimEnd(':'))).Free
Get-ChildItem "$env:windir\\Temp" -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Stop-Service wuauserv, BITS -Force -ErrorAction SilentlyContinue
Get-ChildItem "$env:windir\\SoftwareDistribution\\Download" -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Start-Service BITS, wuauserv -ErrorAction SilentlyContinue
Delete-DeliveryOptimizationCache -Force -ErrorAction SilentlyContinue
$after = (Get-PSDrive ($env:SystemDrive.TrimEnd(':'))).Free
"Freed about $([math]::Round(($after - $before)/1GB, 2)) GB on $env:SystemDrive"`,
  },
  clear_print_queue: {
    title: 'Clear stuck print jobs and restart the print spooler',
    risk: 'change',
    timeoutMs: 2 * 60_000,
    script: `Stop-Service Spooler -Force
$f = @(Get-ChildItem "$env:windir\\System32\\spool\\PRINTERS" -File -Force -ErrorAction SilentlyContinue)
$f | Remove-Item -Force -ErrorAction SilentlyContinue
Start-Service Spooler
"Removed $($f.Count) stuck print file(s); print spooler: $((Get-Service Spooler).Status)"`,
  },
  network_reset: {
    title: 'Reset the network stack (Winsock + TCP/IP) — needs a restart',
    risk: 'change',
    timeoutMs: 2 * 60_000,
    script: `netsh winsock reset | Out-Null; netsh int ip reset | Out-Null; ipconfig /flushdns | Out-Null
'Network stack reset (Winsock, TCP/IP, DNS cache). Restart Windows to finish.'`,
  },
  dism_restorehealth: {
    title: 'Repair the Windows component store (DISM /RestoreHealth)',
    risk: 'change',
    timeoutMs: 90 * 60_000,
    script: `$o = DISM /Online /Cleanup-Image /RestoreHealth | Out-String; ($o -split "\\r?\\n" | Where-Object { $_ -match '\\w' -and $_ -notmatch '^\\s*\\[' }) -join [Environment]::NewLine`,
  },
  sfc_scan: {
    title: 'Check and repair Windows system files (sfc /scannow)',
    risk: 'change',
    timeoutMs: 90 * 60_000,
    script: `$o = sfc /scannow | Out-String; ($o -replace "\\x00", '' -split "\\r?\\n" | Where-Object { $_ -match '\\w' -and $_ -notmatch '% complete' }) -join [Environment]::NewLine`,
  },
  winget_install: {
    title: 'Install an app with winget (as administrator, no UAC prompt)',
    risk: 'change',
    timeoutMs: 60 * 60_000,
    paramHelp: 'winget package id, e.g. VideoLAN.VLC',
    param: (raw) => {
      if (!PACKAGE_ID.test(raw.trim())) throw new Error('Not a winget package id (e.g. VideoLAN.VLC)');
      return raw.trim();
    },
    script: `winget install --id $P --exact --silent --scope machine --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Where-Object { $_ -match '\\w' -and $_ -notmatch '^[\\s\\-\\\\|/█▒]+$' } | Out-String`,
  },
  winget_upgrade: {
    title: 'Upgrade apps with winget (as administrator, no UAC prompt)',
    risk: 'change',
    timeoutMs: 2 * 3600_000,
    paramHelp: 'winget package id, or "all"',
    param: (raw) => {
      const v = raw.trim();
      if (v.toLowerCase() === 'all') return 'all';
      if (!PACKAGE_ID.test(v)) throw new Error('Not a winget package id (e.g. VideoLAN.VLC) or "all"');
      return v;
    },
    script: `$a = if ($P -eq 'all') { @('--all') } else { @('--id', $P, '--exact') }
winget upgrade @a --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Where-Object { $_ -match '\\w' -and $_ -notmatch '^[\\s\\-\\\\|/█▒]+$' } | Out-String`,
  },
};

/** Validates a request; returns the normalized parameter. Throws with a user-facing message. */
export function validateOp(op: string, rawParam = ''): { def: ElevatedOp; param: string } {
  const def = ELEVATED_OPS[op];
  if (!def) throw new Error(`Unknown admin task "${op}". Available: ${Object.keys(ELEVATED_OPS).join(', ')}`);
  const param = def.param ? def.param(rawParam) : '';
  return { def, param };
}
