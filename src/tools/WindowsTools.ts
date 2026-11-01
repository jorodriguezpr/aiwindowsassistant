/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Windows 11 tools (1.4.0): open a Settings page by name, screenshots, apps with winget, admin
 * jobs through the elevated helper, disk clean-up and the health report. Their approval rules
 * live in AITools.toolCallDecision like every other tool.
 */

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolDefinition } from '../providers/AIProvider';
import type { ToolResult, ToolContext } from './AITools';
import { childEnv } from '../security/SecretStore';
import { callElevated, helperState, HELPER_MISSING } from '../elevated/client';
import { ELEVATED_OPS } from '../elevated/ops';
import { analyzeDiskSpace, cleanUpDisk, CLEANUP_TARGETS } from '../services/CleanupService';
import { buildHealthReport } from '../services/HealthCheckService';

// ── Settings ────────────────────────────────────────────────────────────────

/** Windows 11 Settings pages (ms-settings: URIs), by the names people use. */
export const SETTINGS_PAGES: Record<string, string> = {
  settings: '', home: '', display: 'display', screen: 'display', resolution: 'display', 'night light': 'nightlight', brightness: 'display',
  'graphics': 'display-advancedgraphics', sound: 'sound', audio: 'sound', 'sound devices': 'sound-devices', 'volume mixer': 'apps-volume', volume: 'apps-volume',
  notifications: 'notifications', focus: 'quiethours', 'do not disturb': 'quiethours', power: 'powersleep', sleep: 'powersleep', battery: 'batterysaver',
  'battery saver': 'batterysaver', storage: 'storagesense', 'storage sense': 'storagesense', multitasking: 'multitasking', 'snap': 'multitasking',
  about: 'about', 'pc name': 'about', clipboard: 'clipboard', 'remote desktop': 'remotedesktop', bluetooth: 'bluetooth', devices: 'devices',
  printers: 'printers', printer: 'printers', scanners: 'printers', mouse: 'mousetouchpad', touchpad: 'devices-touchpad', usb: 'usb', camera: 'camera',
  'wi-fi': 'network-wifi', wifi: 'network-wifi', network: 'network-status', internet: 'network-status', ethernet: 'network-ethernet', vpn: 'network-vpn',
  proxy: 'network-proxy', hotspot: 'network-mobilehotspot', 'mobile hotspot': 'network-mobilehotspot', 'airplane mode': 'network-airplanemode',
  personalization: 'personalization', background: 'personalization-background', wallpaper: 'personalization-background', colors: 'colors',
  'dark mode': 'colors', themes: 'themes', 'lock screen': 'lockscreen', start: 'personalization-start', 'start menu': 'personalization-start',
  taskbar: 'taskbar', fonts: 'fonts', apps: 'appsfeatures', 'installed apps': 'appsfeatures', 'uninstall': 'appsfeatures', 'default apps': 'defaultapps',
  'startup apps': 'startupapps', startup: 'startupapps', 'optional features': 'optionalfeatures', accounts: 'yourinfo', 'your info': 'yourinfo',
  'sign-in options': 'signinoptions', 'sign in options': 'signinoptions', password: 'signinoptions', pin: 'signinoptions', 'windows hello': 'signinoptions',
  email: 'emailandaccounts', 'other users': 'otherusers', family: 'family-group', 'date and time': 'dateandtime', time: 'dateandtime', date: 'dateandtime',
  'time zone': 'dateandtime', language: 'regionlanguage', region: 'regionformatting', keyboard: 'keyboard', typing: 'typing', speech: 'speech',
  gaming: 'gaming-gamebar', 'game bar': 'gaming-gamebar', 'game mode': 'gaming-gamemode', accessibility: 'easeofaccess', 'text size': 'easeofaccess-display',
  narrator: 'easeofaccess-narrator', magnifier: 'easeofaccess-magnifier', 'contrast themes': 'easeofaccess-highcontrast', 'high contrast': 'easeofaccess-highcontrast',
  captions: 'easeofaccess-closedcaptioning', privacy: 'privacy', location: 'privacy-location', microphone: 'privacy-microphone', 'app permissions': 'privacy',
  'windows security': 'windowsdefender', security: 'windowsdefender', antivirus: 'windowsdefender', defender: 'windowsdefender', firewall: 'windowsdefender',
  'windows update': 'windowsupdate', updates: 'windowsupdate', update: 'windowsupdate', 'update history': 'windowsupdate-history',
  'advanced update': 'windowsupdate-options', recovery: 'recovery', reset: 'recovery', activation: 'activation', 'product key': 'activation',
  troubleshoot: 'troubleshoot', 'for developers': 'developers', developer: 'developers', backup: 'backup', 'windows backup': 'backup',
};

/** Best Settings page for a free-text name, or null. */
export function findSettingsPage(name: string): { key: string; uri: string } | null {
  const q = name.toLowerCase().replace(/\bsettings?\b|\bthe\b|\bpage\b|\bmy\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return { key: 'settings', uri: 'ms-settings:' };
  if (q in SETTINGS_PAGES) return { key: q, uri: `ms-settings:${SETTINGS_PAGES[q]}` };
  // the longest page name contained in the request ("change my wifi password" → wifi)
  const hits = Object.keys(SETTINGS_PAGES).filter((k) => new RegExp(`\\b${k.replace(/[-]/g, '\\-')}\\b`).test(q)).sort((a, b) => b.length - a.length);
  return hits.length ? { key: hits[0], uri: `ms-settings:${SETTINGS_PAGES[hits[0]]}` } : null;
}

function openSettings(page: string): ToolResult {
  const hit = findSettingsPage(page);
  if (!hit) return { success: false, error: `No Settings page called "${page}". Known pages: ${Object.keys(SETTINGS_PAGES).slice(0, 40).join(', ')}…` };
  spawn('cmd.exe', ['/c', 'start', '', hit.uri], { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv() }).unref();
  return { success: true, output: `Opened Settings → ${hit.key}` };
}

// ── screenshot ──────────────────────────────────────────────────────────────

const PS_SCREENSHOT = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][W.U]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($env:AIWA_SHOT, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`;

export function captureScreen(): Promise<string> {
  const dir = path.join(os.tmpdir(), 'aiwa-shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `screen-${Date.now()}.png`);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCREENSHOT], { env: childEnv({ AIWA_SHOT: file }), windowsHide: true, timeout: 30000 }, (err, _o, stderr) => {
      if (err || !fs.existsSync(file)) reject(new Error(String(stderr || err?.message || 'screenshot failed').trim().split('\n')[0]));
      else resolve(file);
    });
  });
}

async function takeScreenshot(ctx: ToolContext): Promise<ToolResult> {
  const file = await captureScreen();
  try {
    if (!ctx.sendFile) return { success: false, error: 'Screenshots can only be sent to Telegram' };
    const big = fs.statSync(file).size > 9 * 1024 * 1024;
    await ctx.sendFile(file, big ? 'document' : 'photo', '🖥️ Screenshot');
    return { success: true, output: 'Screenshot sent to Telegram. (A locked screen captures as black.)' };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ── winget ──────────────────────────────────────────────────────────────────

const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{1,99}$/;

/** winget prints progress bars and spinners; keep the readable lines. */
function cleanWinget(s: string): string {
  return s
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/[▀-▟]+/g, '').trimEnd())
    .filter((l) => /\w/.test(l) && !/^\s*[-\\|/]\s*$/.test(l) && !/^\s*\d+(\.\d+)?\s*(KB|MB|GB)\s*\/\s*\d/.test(l))
    .join('\n')
    .slice(0, 3500);
}

export function winget(args: string[], timeoutMs = 120000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('winget', [...args, '--accept-source-agreements', '--disable-interactivity'], { env: childEnv(), windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: cleanWinget(`${stdout || ''}${stderr ? '\n' + stderr : ''}`) || (err ? err.message : '') })
    );
  });
}

/** "vlc" → the package id winget would install, or the list to choose from. */
async function resolvePackage(query: string): Promise<{ id?: string; list?: string }> {
  if (PACKAGE_ID.test(query) && query.includes('.')) return { id: query };
  const r = await winget(['search', '--query', query, '--count', '8']);
  const rows = r.out.split('\n').filter((l) => /\S+\s{2,}[A-Za-z0-9][\w.+-]+\.[\w.+-]+\s{2,}/.test(l));
  const exact = rows.filter((l) => l.trim().toLowerCase().startsWith(query.toLowerCase() + ' ') || l.toLowerCase().split(/\s{2,}/)[0].trim() === query.toLowerCase());
  const idOf = (l: string) => l.split(/\s{2,}/).map((c) => c.trim()).find((c) => /^[A-Za-z0-9][\w+-]*\.[\w.+-]+$/.test(c));
  if (exact.length === 1 && idOf(exact[0])) return { id: idOf(exact[0]) };
  if (rows.length === 1 && idOf(rows[0])) return { id: idOf(rows[0]) };
  return { list: r.out || `Nothing found for "${query}"` };
}

async function appsInstall(query: string, upgrade: boolean): Promise<ToolResult> {
  const q = query.trim();
  if (!q) return { success: false, error: 'Which app?' };
  if (upgrade && q.toLowerCase() === 'all') {
    if (helperState().running) {
      const r = await callElevated('winget_upgrade', 'all');
      return { success: r.ok, output: r.output, error: r.error };
    }
    const r = await winget(['upgrade', '--all', '--silent', '--accept-package-agreements'], 2 * 3600_000);
    return { success: r.ok, output: r.out, error: r.ok ? undefined : `${r.out}\n(Some apps need administrator rights: ${HELPER_MISSING})` };
  }
  const pkg = await resolvePackage(q);
  if (!pkg.id) return { success: false, error: `Several or no matches — say which one by its id:\n${pkg.list}` };
  if (helperState().running) {
    const r = await callElevated(upgrade ? 'winget_upgrade' : 'winget_install', pkg.id);
    return { success: r.ok, output: `${pkg.id}: ${r.output || ''}`, error: r.error };
  }
  const r = await winget([upgrade ? 'upgrade' : 'install', '--id', pkg.id, '--exact', '--silent', '--accept-package-agreements'], 3600_000);
  return { success: r.ok, output: `${pkg.id}:\n${r.out}`, error: r.ok ? undefined : `${pkg.id}: ${r.out}` };
}

// ── definitions + executor ──────────────────────────────────────────────────

export const WINDOWS_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'open_settings',
    description: 'Open a Windows 11 Settings page by name, e.g. "bluetooth", "display", "windows update", "default apps", "sound", "wifi", "privacy".',
    parameters: { type: 'object', properties: { page: { type: 'string', description: 'Settings page name' } }, required: ['page'] },
  },
  {
    name: 'take_screenshot',
    description: "Take a screenshot of this PC's screen(s) and send it to the user in Telegram.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'apps_search',
    description: 'Search apps available to install with winget (Windows Package Manager).',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'apps_updates',
    description: 'List installed apps that have updates available (winget upgrade).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'apps_install',
    description: 'Install an app with winget, by name ("vlc") or winget id ("VideoLAN.VLC"). Needs the user\'s approval.',
    parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
  },
  {
    name: 'apps_upgrade',
    description: 'Upgrade one app (name or winget id) or "all" apps with winget. Needs the user\'s approval.',
    parameters: { type: 'object', properties: { app: { type: 'string', description: 'App name/id, or "all"' } }, required: ['app'] },
  },
  {
    name: 'admin_task',
    description:
      'Run an administrator job through the elevated helper. Tasks: ' +
      Object.entries(ELEVATED_OPS).map(([k, v]) => `${k} (${v.title}${v.paramHelp ? `; param: ${v.paramHelp}` : ''})`).join('; '),
    parameters: {
      type: 'object',
      properties: { task: { type: 'string', enum: Object.keys(ELEVATED_OPS) }, param: { type: 'string', description: 'Only for tasks that take one' } },
      required: ['task'],
    },
  },
  {
    name: 'analyze_disk_space',
    description: 'Find what can be cleaned to free disk space (temp files, caches, Recycle Bin, old installers, Windows update cache). Changes nothing.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'clean_up_disk',
    description: `Free disk space by cleaning the chosen targets (run analyze_disk_space first). Targets: ${CLEANUP_TARGETS.map((t) => t.id).join(', ')}. Needs the user's approval.`,
    parameters: { type: 'object', properties: { targets: { type: 'string', description: 'Comma-separated target ids, or "all-safe"' } }, required: ['targets'] },
  },
  {
    name: 'health_report',
    description: 'Check the health of this PC (disk, updates, Defender, firewall, restarts, errors, disks, memory…) and send a PDF report to Telegram.',
    parameters: { type: 'object', properties: {} },
  },
];

export const WINDOWS_TOOL_NAMES = new Set(WINDOWS_TOOL_DEFINITIONS.map((d) => d.name));

export async function executeWindowsTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const s = (k: string) => String(args[k] ?? '').trim();
  try {
    switch (name) {
      case 'open_settings':
        return openSettings(s('page'));
      case 'take_screenshot':
        return await takeScreenshot(ctx);
      case 'apps_search': {
        const r = await winget(['search', '--query', s('query'), '--count', '15']);
        return { success: r.ok, output: r.out };
      }
      case 'apps_updates': {
        const r = await winget(['upgrade', '--include-unknown'], 180000);
        return { success: true, output: r.out };
      }
      case 'apps_install':
        return await appsInstall(s('app'), false);
      case 'apps_upgrade':
        return await appsInstall(s('app'), true);
      case 'admin_task': {
        const r = await callElevated(s('task'), s('param'));
        return { success: r.ok, output: r.output, error: r.error };
      }
      case 'analyze_disk_space':
        return { success: true, output: await analyzeDiskSpace() };
      case 'clean_up_disk':
        return { success: true, output: await cleanUpDisk(s('targets')) };
      case 'health_report': {
        const rep = await buildHealthReport();
        if (ctx.sendFile) await ctx.sendFile(rep.pdfPath, 'document', `🩺 Health report — score ${rep.score}/100`);
        return { success: true, output: rep.summary };
      }
      default:
        return { success: false, error: `Unknown Windows tool: ${name}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
