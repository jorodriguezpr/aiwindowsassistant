/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Windows notifications ("toasts"): approval requests with Approve / Deny buttons when you are
 * at the PC (Telegram keeps working — the first answer wins), and a note when a long task ends.
 *
 * No packaging needed: the app registers an AppUserModelID (name + icon) and an `aiwa:` URL
 * protocol under HKCU. A button opens aiwa://approve/<nonce>; Windows starts this assistant
 * hidden with --toast-action, which hands the click to the running app over loopback
 * (ApprovalHookServer /toast). The nonce is random per approval and only shown in that toast,
 * so a crafted aiwa:// link can't approve anything.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { config } from '../config';
import { childEnv } from '../security/SecretStore';
import { writeHiddenSelfLauncher } from '../utils/launcher';
import type { Logger } from '../logger';

export const AUMID = 'AiWindowsAssistant';
const RUNTIME_FILE = () => path.join(config.dataDir, 'runtime.json');

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
/** Telegram Markdown out, toast plain text in. */
const plain = (s: string) => s.replace(/[*_`]/g, '');

const PS_SHOW = `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml($env:AIWA_TOAST_XML)
$t = New-Object Windows.UI.Notifications.ToastNotification $x
if ($env:AIWA_TOAST_TAG) { $t.Tag = $env:AIWA_TOAST_TAG; $t.Group = 'aiwa' }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:AIWA_AUMID).Show($t)`;
const PS_REMOVE = `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[Windows.UI.Notifications.ToastNotificationManager]::History.Remove($env:AIWA_TOAST_TAG, 'aiwa', $env:AIWA_AUMID)`;

export class ToastService {
  private ready = false;

  constructor(private logger?: Logger) {}

  get enabled(): boolean {
    return config.toast.enabled && this.ready;
  }

  /** Registers the app name/icon and the aiwa: protocol (HKCU, no admin). Safe to call each start. */
  register(): void {
    if (!config.toast.enabled) return;
    try {
      const reg = (key: string, args: string[]) => execFileSync('reg', ['add', key, ...args, '/f'], { stdio: 'ignore', windowsHide: true });
      const app = `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`;
      reg(app, ['/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'AiWindowsAssistant']);
      const icon = path.join(config.assetsDir, 'icon.ico');
      if (fs.existsSync(icon)) reg(app, ['/v', 'IconUri', '/t', 'REG_SZ', '/d', icon]);
      const vbs = writeHiddenSelfLauncher('toast-action', ['--toast-action']);
      reg('HKCU\\Software\\Classes\\aiwa', ['/ve', '/t', 'REG_SZ', '/d', 'URL:AiWindowsAssistant']);
      reg('HKCU\\Software\\Classes\\aiwa', ['/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '']);
      reg('HKCU\\Software\\Classes\\aiwa\\shell\\open\\command', ['/ve', '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}" "%1"`]);
      this.ready = true;
    } catch (err) {
      this.logger?.warn({ err }, 'toast registration failed — Windows notifications off');
    }
  }

  private run(script: string, env: Record<string, string>): void {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: childEnv({ AIWA_AUMID: AUMID, ...env }), windowsHide: true, timeout: 20000 }, (err) => {
      if (err) this.logger?.warn({ err: err.message }, 'toast failed');
    });
  }

  /** A plain notification. */
  notify(title: string, body: string): void {
    if (!this.enabled) return;
    const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(plain(title))}</text><text>${xmlEscape(plain(body).slice(0, 300))}</text></binding></visual></toast>`;
    this.run(PS_SHOW, { AIWA_TOAST_XML: xml, AIWA_TOAST_TAG: '' });
  }

  /** An approval request with Approve / Deny buttons; `tag` lets it be withdrawn later. */
  approval(tag: string, nonce: string, description: string): void {
    if (!this.enabled) return;
    const xml =
      `<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>AiWindowsAssistant — approval required</text>` +
      `<text>${xmlEscape(plain(description).slice(0, 400))}</text></binding></visual><actions>` +
      `<action content="Approve" activationType="protocol" arguments="aiwa://approve/${nonce}"/>` +
      `<action content="Deny" activationType="protocol" arguments="aiwa://deny/${nonce}"/></actions></toast>`;
    this.run(PS_SHOW, { AIWA_TOAST_XML: xml, AIWA_TOAST_TAG: tag });
  }

  /** Withdraw an approval toast once it was answered (from either side) or expired. */
  remove(tag: string): void {
    if (!this.enabled) return;
    this.run(PS_REMOVE, { AIWA_TOAST_TAG: tag });
  }
}

/** index.ts: where the running app's loopback server listens, for --toast-action. */
export function writeRuntimeFile(port: number): void {
  fs.writeFileSync(RUNTIME_FILE(), JSON.stringify({ port, pid: process.pid }));
}

/** `--toast-action aiwa://approve/<nonce>`: forward a toast click to the running app. */
export async function forwardToastAction(url: string): Promise<void> {
  const m = /^aiwa:\/\/(approve|deny)\/([a-f0-9]{32})\/?$/i.exec(String(url || '').trim());
  if (!m) return;
  const { port } = JSON.parse(fs.readFileSync(RUNTIME_FILE(), 'utf8')) as { port: number };
  const body = JSON.stringify({ nonce: m[2].toLowerCase(), approve: m[1].toLowerCase() === 'approve' });
  await new Promise<void>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/toast', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.end(body);
  });
}
