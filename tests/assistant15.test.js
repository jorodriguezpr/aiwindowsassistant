// AiWindowsAssistant
// Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
// GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
//
// 1.5.0: one gate + 10-min grants, MCP server, UI Automation rules, repair routines, alerts, chat window.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const WORKSPACE = path.join(os.tmpdir(), 'aiwa-test-workspace');
process.env.CLAUDE_WORKSPACE = WORKSPACE;
process.env.DEFAULT_CWD = WORKSPACE;
process.env.TRUSTED_COMMANDS = '';
process.env.AI_PROVIDER = 'ollama';
process.env.TOAST_NOTIFICATIONS = 'false';
fs.mkdirSync(WORKSPACE, { recursive: true });

const dist = path.join(__dirname, '..', 'dist');
const { gateToolCall, grant } = require(path.join(dist, 'security', 'Gate'));
const { toolCallDecision } = require(path.join(dist, 'tools', 'AITools'));
const { describeRoutine, ROUTINES } = require(path.join(dist, 'services', 'RepairService'));
const { findAlerts } = require(path.join(dist, 'services', 'AlertService'));
const { WebChat, parseHotkey } = require(path.join(dist, 'gateways', 'WebChat'));
const { ApprovalHookServer } = require(path.join(dist, 'tools', 'ApprovalHookServer'));
const { RequestAnalyzer } = require(path.join(dist, 'core', 'RequestAnalyzer'));

test('gate: deny never asks, ask asks, a 10-min grant covers one window only', async () => {
  const asked = [];
  const approve = async (d, key) => (asked.push(key), false);
  assert.strictEqual((await gateToolCall(7, 'read_file', { path: path.join(os.homedir(), '.ssh', 'id_rsa') }, 'x', approve)).blocked, true);
  assert.strictEqual(asked.length, 0);
  assert.strictEqual((await gateToolCall(7, 'ui_click', { window: 'Notepad', target: 'Save' }, 'x', approve)).ok, false);
  assert.deepStrictEqual(asked, ['ui:notepad'], 'UI clicks offer a grant keyed by window');
  grant(7, 'ui:notepad', 10);
  assert.strictEqual((await gateToolCall(7, 'ui_click', { window: 'notepad', target: 'Save' }, 'x', approve)).ok, true);
  assert.strictEqual((await gateToolCall(8, 'ui_click', { window: 'notepad', target: 'Save' }, 'x', approve)).ok, false, 'other chat: no grant');
  assert.strictEqual((await gateToolCall(7, 'ui_click', { window: 'Calculator', target: '1' }, 'x', approve)).ok, false, 'other window: no grant');
  assert.strictEqual((await gateToolCall(7, 'apps_install', { app: 'vlc' }, 'x', approve)).ok, false, 'grants never cover other actions');
});

test('UI Automation rules', () => {
  const v = (n, a) => toolCallDecision(n, a).verdict;
  assert.strictEqual(v('ui_list_windows', {}), 'allow');
  assert.strictEqual(v('ui_inspect', { window: 'x' }), 'allow');
  assert.strictEqual(v('ui_window', { window: 'x', action: 'snap-left' }), 'allow');
  assert.strictEqual(v('ui_window', { window: 'x', action: 'close' }), 'ask');
  assert.strictEqual(toolCallDecision('ui_window', { window: 'x', action: 'close' }).grantKey, undefined, 'closing never covered by a grant');
  assert.strictEqual(v('ui_type', { window: 'x', text: 'hi' }), 'ask');
  assert.strictEqual(v('ui_keys', { window: 'x', keys: '^s' }), 'ask');
});

test('repair routines', () => {
  assert.strictEqual(toolCallDecision('run_repair', { routine: 'slow-pc' }).verdict, 'allow', 'diagnosis only');
  const d = toolCallDecision('run_repair', { routine: 'windows-update' });
  assert.strictEqual(d.verdict, 'ask');
  assert.match(d.reason, /0\. Create a System Restore point[\s\S]*sfc/);
  assert.strictEqual(describeRoutine('nope'), null);
  for (const [name, r] of Object.entries(ROUTINES)) for (const s of r.steps) assert.ok(s.tool, `${name} has tools`);
  const a = new RequestAnalyzer();
  assert.deepStrictEqual(a.analyze('fix my printer').args, { routine: 'printer' });
  assert.deepStrictEqual(a.analyze('fix the wifi').args, { routine: 'internet' });
  assert.strictEqual(a.analyze('what windows are open').tool, 'ui_list_windows');
});

test('alerts: only real news', () => {
  const base = { startup: ['OneDrive (HKU)\tonedrive.exe'], services: ['Spooler\tPrint Spooler: spoolsv.exe', 'edgeupdate\tEdge Update: C:\\Edge\\130.0\\x.exe'], tasks: [] };
  const snap = {
    systemDrive: 'C:', freeGB: 80, sizeGB: 476, detections: [], crashes: 0, badDisks: [], rebootPending: false, uptimeDays: 1,
    startup: ['OneDrive (HKU)\tonedrive.exe'], services: ['Spooler\tPrint Spooler: spoolsv.exe', 'edgeupdate\tEdge Update: C:\\Edge\\131.0\\x.exe'], tasks: [],
  };
  assert.deepStrictEqual(findAlerts(snap, base), [], 'an update moving a service exe is not news');
  const bad = { ...snap, freeGB: 3, crashes: 1, detections: ['Trojan:Win32/X in C:\\x.exe'], services: [...snap.services, 'evilsvc\tUpdater: C:\\Users\\x\\AppData\\evil.exe'], tasks: ['\\Updater\tC:\\Users\\x\\a.ps1'] };
  const keys = findAlerts(bad, base).map((a) => a.key.split(':')[0]);
  assert.deepStrictEqual(keys.sort(), ['crash', 'defender', 'disk-full', 'service', 'task']);
});

test('MCP server: lists the tools and forwards calls with the token', async () => {
  const calls = [];
  const server = new ApprovalHookServer(async () => false);
  server.toolRunner = async (chatId, name, args) => (calls.push([chatId, name, args]), { success: true, output: `ran ${name}` });
  const port = await server.start();
  const child = spawn(process.execPath, [path.join(dist, 'index.js'), '--mcp-server'], {
    env: { ...process.env, AIWA_APPROVAL_PORT: String(port), AIWA_APPROVAL_TOKEN: server.token, AIWA_CHAT_ID: '42' },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const rpc = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 150; i++) {
      const hit = lines.find((l) => l.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no answer to ${method}`);
  };
  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.strictEqual(init.result.serverInfo.name, 'aiwa');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const names = (await rpc(2, 'tools/list', {})).result.tools.map((t) => t.name);
    for (const n of ['open_settings', 'take_screenshot', 'ui_click', 'run_repair', 'admin_task', 'health_report']) assert.ok(names.includes(n), n);
    for (const n of ['execute_command', 'read_file', 'delegate_to_claude_code']) assert.ok(!names.includes(n), `${n} not exposed`);
    const r = await rpc(3, 'tools/call', { name: 'open_settings', arguments: { page: 'display' } });
    assert.strictEqual(r.result.content[0].text, 'ran open_settings');
    assert.deepStrictEqual(calls, [[42, 'open_settings', { page: 'display' }]]);
    assert.ok(lines.every((l) => l.jsonrpc === '2.0'), 'stdout carries only protocol messages');
  } finally {
    child.kill();
    server.stop();
  }
});

function req(port, method, p, headers = {}, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.end(body);
  });
}

test('chat window: secret URL → cookie, Host/Origin checks, mirrors the feed, buttons answer', async () => {
  const typed = [], pressed = [];
  const chat = new WebChat({ onText: (t) => typed.push(t), onButton: (d) => (pressed.push(d), true) });
  const port = await chat.start();
  try {
    assert.strictEqual((await req(port, 'GET', '/')).status, 403, 'no cookie');
    assert.strictEqual((await req(port, 'GET', '/open?t=wrong')).status, 403);
    const open = await req(port, 'GET', new URL(chat.url()).pathname + new URL(chat.url()).search);
    assert.strictEqual(open.status, 302);
    const cookie = String(open.headers['set-cookie']).split(';')[0];
    assert.match(String(open.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.strictEqual((await req(port, 'GET', '/', { cookie })).status, 200);
    assert.strictEqual((await req(port, 'GET', '/', { cookie, host: 'evil.example:80' })).status, 403, 'DNS rebinding');
    const origin = `http://127.0.0.1:${port}`;
    assert.strictEqual((await req(port, 'POST', '/send', { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, '{"text":"x"}')).status, 403, 'cross-site POST');
    assert.strictEqual((await req(port, 'POST', '/send', { cookie, origin, 'content-type': 'application/json' }, '{"text":"health check"}')).status, 204);
    assert.deepStrictEqual(typed, ['health check']);
    chat.push({ mid: 5, who: 'bot', text: 'Approval required', buttons: [['✅ Approve', 'appr:ab12']] });
    chat.push({ mid: 5, who: 'bot', text: 'Approved' });
    const feed = JSON.parse((await req(port, 'GET', '/feed?after=0', { cookie })).body);
    assert.deepStrictEqual(feed.map((f) => f.text), ['health check', 'Approved'], 'edits replace the line');
    await req(port, 'POST', '/answer', { cookie, origin, 'content-type': 'application/json' }, '{"data":"appr:ab12"}');
    assert.deepStrictEqual(pressed, ['appr:ab12']);
  } finally {
    chat.stop();
  }
});

test('hotkey parsing', () => {
  assert.deepStrictEqual(parseHotkey('Ctrl+Alt+Space'), { mod: 0x4000 | 2 | 1, vk: 0x20 });
  assert.deepStrictEqual(parseHotkey('Win+Shift+A'), { mod: 0x4000 | 8 | 4, vk: 0x41 });
  assert.strictEqual(parseHotkey('Space'), null, 'needs a modifier');
  assert.strictEqual(parseHotkey('Ctrl+Banana'), null);
});
