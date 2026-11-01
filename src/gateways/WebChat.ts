/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Chat window at the PC (1.5.0). A hotkey (CHAT_HOTKEY, default Ctrl+Alt+Space) or the tray menu
 * opens a small Edge app window on this loopback page. It is the owner's Telegram conversation,
 * mirrored: what you type here goes through exactly the same pipeline as a Telegram message
 * (commands, shortcuts, engines, approvals), and everything the bot says to the owner shows here
 * too — with working Approve/Deny buttons. 🎤 uses the browser's speech recognition.
 *
 * Security: binds 127.0.0.1 only; opened through a per-run secret URL that swaps itself for an
 * HttpOnly cookie; every request must carry that cookie, the exact Host 127.0.0.1:<port> (no
 * DNS rebinding) and, for POSTs, the same Origin (no cross-site requests).
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { childEnv } from '../security/SecretStore';
import type { Logger } from '../logger';

export interface FeedItem {
  n: number;
  /** Telegram message id, when it mirrors one (edits/deletes target it) */
  mid?: number;
  who: 'bot' | 'me' | 'note';
  text: string;
  /** inline-keyboard buttons of an approval prompt: [label, callback data] */
  buttons?: [string, string][];
  deleted?: boolean;
}

export interface WebChatHooks {
  /** text typed in the window: handled like a Telegram message from the owner */
  onText: (text: string) => void;
  /** a button press: same callback data as Telegram's inline keyboard */
  onButton: (data: string) => boolean;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>AiWindowsAssistant</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#f3f4f6;--me:#2563eb;--bot:#fff;--fg:#111;--muted:#6b7280}
@media (prefers-color-scheme:dark){:root{--bg:#111827;--bot:#1f2937;--fg:#f3f4f6;--muted:#9ca3af}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 "Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--fg);display:flex;flex-direction:column;height:100vh}
#feed{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.m{max-width:88%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.bot{background:var(--bot);align-self:flex-start;box-shadow:0 1px 2px #0002}.me{background:var(--me);color:#fff;align-self:flex-end}
.note{align-self:center;color:var(--muted);font-size:12px}
.b{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}.b button{border:0;border-radius:8px;padding:6px 10px;cursor:pointer;background:#e5e7eb}
.b button.ok{background:#16a34a;color:#fff}.b button.no{background:#dc2626;color:#fff}
form{display:flex;gap:6px;padding:10px;border-top:1px solid #8883}
textarea{flex:1;resize:none;height:42px;border-radius:10px;border:1px solid #8885;padding:10px;font:inherit;background:var(--bot);color:var(--fg)}
form button{border:0;border-radius:10px;padding:0 14px;cursor:pointer;background:var(--me);color:#fff;font-size:16px}
#mic.on{background:#dc2626}
</style></head><body>
<div id="feed"><div class="m note">Same conversation as Telegram. Try "health check", "open bluetooth settings", "/fix".</div></div>
<form id="f"><button type="button" id="mic" title="Speak">🎤</button><textarea id="t" placeholder="Ask or tell me what to do…" autofocus></textarea><button>➤</button></form>
<script>
let last=0;const feed=document.getElementById('feed'),t=document.getElementById('t'),items={};
function render(it){let el=it.mid&&items[it.mid];if(it.deleted){if(el)el.remove();return}
 if(!el){el=document.createElement('div');feed.appendChild(el);if(it.mid)items[it.mid]=el}
 el.className='m '+it.who;el.textContent=it.text;
 if(it.buttons&&it.buttons.length){const b=document.createElement('div');b.className='b';
  for(const [label,data] of it.buttons){const x=document.createElement('button');x.textContent=label;
   x.className=data.startsWith('deny')?'no':'ok';x.onclick=()=>post('/answer',{data}).then(()=>b.remove());b.appendChild(x)}
  el.appendChild(b)}
 feed.scrollTop=feed.scrollHeight}
function post(u,body){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})}
async function poll(){try{const r=await fetch('/feed?after='+last);if(r.status===403){render({who:'note',text:'Session expired — press the hotkey again.'});return}
 for(const it of await r.json()){last=Math.max(last,it.n);render(it)}}catch(e){}setTimeout(poll,800)}
document.getElementById('f').onsubmit=e=>{e.preventDefault();const s=t.value.trim();if(!s)return;t.value='';render({who:'me',text:s});post('/send',{text:s})};
t.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('f').requestSubmit()}};
const SR=window.SpeechRecognition||window.webkitSpeechRecognition,mic=document.getElementById('mic');
if(!SR)mic.style.display='none';else{const r=new SR();r.lang=navigator.language;r.interimResults=true;
 r.onresult=e=>{t.value=[...e.results].map(x=>x[0].transcript).join('')};r.onend=()=>{mic.classList.remove('on');if(t.value.trim())document.getElementById('f').requestSubmit()};
 mic.onclick=()=>{if(mic.classList.contains('on'))r.stop();else{t.value='';mic.classList.add('on');r.start()}}}
poll();
</script></body></html>`;

export class WebChat {
  private server: http.Server;
  port = 0;
  /** in the URL the hotkey opens; exchanged for the session cookie */
  private readonly urlToken = crypto.randomBytes(24).toString('hex');
  private readonly session = crypto.randomBytes(24).toString('hex');
  private feed: FeedItem[] = [];
  private seq = 0;
  private hotkeyProc?: ChildProcess;

  constructor(private hooks: WebChatHooks, private logger?: Logger) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/open?t=${this.urlToken}`;
  }

  /** Add or update a line in the window (mirror of what the bot sends). */
  push(item: Omit<FeedItem, 'n'>): void {
    const n = ++this.seq;
    if (item.mid !== undefined) this.feed = this.feed.filter((f) => f.mid !== item.mid);
    this.feed.push({ ...item, n });
    if (this.feed.length > 300) this.feed = this.feed.slice(-300);
  }

  private cookieOk(req: http.IncomingMessage): boolean {
    const m = /(?:^|;\s*)aiwa_chat=([a-f0-9]+)/.exec(String(req.headers.cookie || ''));
    if (!m) return false;
    const a = Buffer.from(m[1]), b = Buffer.from(this.session);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = `http://127.0.0.1:${this.port}`;
    if (req.headers.host !== `127.0.0.1:${this.port}`) return void res.writeHead(403).end(); // DNS rebinding
    const url = new URL(req.url || '/', origin);
    if (req.method === 'GET' && url.pathname === '/open') {
      const t = Buffer.from(url.searchParams.get('t') || ''), want = Buffer.from(this.urlToken);
      if (t.length !== want.length || !crypto.timingSafeEqual(t, want)) return void res.writeHead(403).end('Open the chat with the hotkey or the tray menu.');
      res.writeHead(302, { 'set-cookie': `aiwa_chat=${this.session}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
      return void res.end();
    }
    if (!this.cookieOk(req)) return void res.writeHead(403).end('Open the chat with the hotkey or the tray menu.');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
      return void res.end(PAGE);
    }
    if (req.method === 'GET' && url.pathname === '/feed') {
      const after = Number(url.searchParams.get('after')) || 0;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify(this.feed.filter((f) => f.n > after)));
    }
    if (req.method === 'POST' && (url.pathname === '/send' || url.pathname === '/answer')) {
      if (req.headers.origin !== origin) return void res.writeHead(403).end();
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString('utf-8');
        if (body.length > 20000) req.destroy();
      });
      req.on('end', () => {
        try {
          const j = JSON.parse(body) as { text?: string; data?: string };
          if (url.pathname === '/send' && j.text?.trim()) {
            this.push({ who: 'me', text: j.text.trim() });
            this.hooks.onText(j.text.trim());
          } else if (url.pathname === '/answer' && j.data) this.hooks.onButton(j.data);
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      });
      return;
    }
    res.writeHead(404).end();
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const a = this.server.address();
        this.port = typeof a === 'object' && a ? a.port : 0;
        resolve(this.port);
      });
    });
  }

  /** Opens the chat window (Edge app mode, falls back to the default browser). */
  open(): void {
    spawn('cmd.exe', ['/c', 'start', '', 'msedge', `--app=${this.url()}`, '--window-size=460,720'], { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv() })
      .on('exit', (code) => {
        if (code) spawn('cmd.exe', ['/c', 'start', '', this.url()], { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv() }).unref();
      })
      .unref();
  }

  /** Global hotkey: a small hidden PowerShell process with RegisterHotKey; exits with this app. */
  startHotkey(): void {
    const parsed = parseHotkey(config.chatWindow.hotkey);
    if (!parsed) {
      this.logger?.warn({ hotkey: config.chatWindow.hotkey }, 'CHAT_HOTKEY not understood (e.g. Ctrl+Alt+Space) — use the tray menu');
      return;
    }
    this.hotkeyProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PS_HOTKEY], {
      env: childEnv({ AIWA_HK_MOD: String(parsed.mod), AIWA_HK_VK: String(parsed.vk), AIWA_CHAT_URL: this.url(), AIWA_PARENT_PID: String(process.pid) }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    this.hotkeyProc.stdout?.on('data', (d: Buffer) => {
      if (/HOTKEY_TAKEN/.test(d.toString())) this.logger?.warn({ hotkey: config.chatWindow.hotkey }, 'chat hotkey is already used by another program — set CHAT_HOTKEY');
    });
  }

  stop(): void {
    this.hotkeyProc?.kill();
    this.server.close();
  }
}

/** "Ctrl+Alt+Space" → RegisterHotKey modifiers + virtual key. */
export function parseHotkey(s: string): { mod: number; vk: number } | null {
  const MODS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, shift: 4, win: 8 };
  const KEYS: Record<string, number> = { space: 0x20, enter: 0x0d, tab: 0x09, home: 0x24, end: 0x23, insert: 0x2d, pause: 0x13 };
  let mod = 0x4000; // MOD_NOREPEAT
  let vk = 0;
  for (const part of s.toLowerCase().split('+').map((p) => p.trim())) {
    if (MODS[part]) mod |= MODS[part];
    else if (KEYS[part]) vk = KEYS[part];
    else if (/^[a-z0-9]$/.test(part)) vk = part.toUpperCase().charCodeAt(0);
    else if (/^f([1-9]|1[0-2])$/.test(part)) vk = 0x6f + Number(part.slice(1));
    else return null;
  }
  return vk && mod !== 0x4000 ? { mod, vk } : null;
}

const PS_HOTKEY = String.raw`Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System; using System.Diagnostics; using System.Runtime.InteropServices; using System.Windows.Forms;
public class AiwaHotkey : NativeWindow {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
  string url; int parent; Timer t;
  public AiwaHotkey(uint mod, uint vk, string url, int parent) {
    this.url = url; this.parent = parent; CreateHandle(new CreateParams());
    if (!RegisterHotKey(Handle, 1, mod, vk)) { Console.WriteLine("HOTKEY_TAKEN"); }
    t = new Timer(); t.Interval = 5000; t.Tick += (s, e) => { try { Process.GetProcessById(parent); } catch { Application.Exit(); } }; t.Start();
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0312) {
      try { Process.Start("msedge.exe", "--app=\"" + url + "\" --window-size=460,720"); } catch { Process.Start(url); }
    }
    base.WndProc(ref m);
  }
}
'@
$h = New-Object AiwaHotkey ([uint32]$env:AIWA_HK_MOD), ([uint32]$env:AIWA_HK_VK), $env:AIWA_CHAT_URL, ([int]$env:AIWA_PARENT_PID)
[System.Windows.Forms.Application]::Run()`;
