// AiWindowsAssistant
// Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
// GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
//
// 1.6.0: engine choice (Claude Code by default, the assistant engine opt-in) and the chat-window avatar.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const test = require('node:test');
const assert = require('node:assert');

const WORKSPACE = path.join(os.tmpdir(), 'aiwa-test-workspace');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwa-test-'));
process.env.CLAUDE_WORKSPACE = WORKSPACE;
process.env.DEFAULT_CWD = WORKSPACE;
process.env.TOAST_NOTIFICATIONS = 'false';
process.env.AI_PROVIDER = 'ollama';
process.env.AI_MODEL = 'test-model';
process.env.DEFAULT_ENGINE = '';
process.env.WORKER_ENGINE = '';
fs.mkdirSync(WORKSPACE, { recursive: true });

// a stand-in for Ollama's OpenAI-compatible API
const seen = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body);
    seen.push({ path: req.url, tools: (j.tools || []).map((t) => t.function?.name), last: j.messages[j.messages.length - 1].content });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'RECONSTRUCTED: class A {}' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
  });
});

const dist = path.join(__dirname, '..', 'dist');
let config, EngineSettings, runOnEngine, READ_ONLY_TOOLS, WebChat, loadAvatarPack;

test.before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  ({ config } = require(path.join(dist, 'config')));
  config.dataDir = DATA; // engine.json goes to a temp folder, not the real data/
  EngineSettings = require(path.join(dist, 'services', 'EngineSettings'));
  ({ runOnEngine, READ_ONLY_TOOLS } = require(path.join(dist, 'services', 'WorkerEngine')));
  ({ WebChat, loadAvatarPack } = require(path.join(dist, 'gateways', 'WebChat')));
});
test.after(() => fake.close());

test('Claude Code stays the default; the assistant engine is opt-in and remembered', () => {
  assert.strictEqual(EngineSettings.getEngine('tasks'), 'claude');
  assert.strictEqual(EngineSettings.getEngine('workers'), 'claude');
  EngineSettings.setEngine('workers', 'assistant');
  assert.strictEqual(EngineSettings.getEngine('workers'), 'assistant');
  assert.strictEqual(EngineSettings.getEngine('tasks'), 'claude', 'switching workers leaves your tasks alone');
  EngineSettings.setEngine('workers', 'claude');
  assert.strictEqual(EngineSettings.getEngine('workers'), 'claude', 'and back to Claude Code');
  assert.strictEqual(EngineSettings.parseEngine('ollama', 'claude'), 'assistant');
  assert.strictEqual(EngineSettings.parseEngine('nonsense', 'claude'), 'claude');
});

test('BJavaDecompiler delegation on the assistant engine: one completion, no tools', async () => {
  seen.length = 0;
  const neverClaude = { run: () => assert.fail('Claude Code must not be used') };
  const r = await runOnEngine('assistant', { chatId: -1, prompt: 'Reconstruct this class', mode: 'text', claudeBridge: neverClaude, hookSettingsPath: '' });
  assert.ok(r.success);
  assert.strictEqual(r.output, 'RECONSTRUCTED: class A {}');
  assert.strictEqual(seen[0].path, '/v1/chat/completions');
  assert.deepStrictEqual(seen[0].tools, [], 'pure text: no tools offered');
});

test('Fleet escalation on the assistant engine: read-only tools only', async () => {
  seen.length = 0;
  const r = await runOnEngine('assistant', { chatId: -2, prompt: 'Why is the disk full?', mode: 'readonly', claudeBridge: {}, hookSettingsPath: '' });
  assert.ok(r.success);
  const offered = new Set(seen[0].tools);
  assert.ok([...offered].every((t) => READ_ONLY_TOOLS.has(t)), `only read-only tools offered: ${[...offered]}`);
  for (const t of ['write_file', 'delete_file', 'apps_install', 'admin_task', 'ui_click', 'run_repair']) assert.ok(!offered.has(t), `${t} not offered`);
  assert.match(seen[0].last, /read-only investigation/);
});

test('Claude Code engine still goes to Claude Code', async () => {
  const calls = [];
  const bridge = { run: async (chatId, prompt, opts) => (calls.push(opts.hookSettingsPath), { success: true, output: 'from claude', durationMs: 1 }) };
  const r = await runOnEngine('claude', { chatId: 1, prompt: 'x', mode: 'text', claudeBridge: bridge, hookSettingsPath: 'readonly.json' });
  assert.strictEqual(r.output, 'from claude');
  assert.deepStrictEqual(calls, ['readonly.json'], 'with the read-only hook');
});

function req(port, p, headers = {}) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
  });
}

test('avatar pack: binary format, served only to the signed-in window, attribution shown', async () => {
  const crypto = require('crypto');
  const pack = path.join(DATA, 'avatar.bin');
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(zlib.gzipSync(JSON.stringify({ v: 2, js: 'window.SysAiAvatarClassic={};', mesh: '{"v":5}' }))), c.final()]);
  fs.writeFileSync(pack, Buffer.concat([Buffer.from('SABAVTR2'), iv, c.getAuthTag(), enc]));
  assert.deepStrictEqual(loadAvatarPack(pack, key), { js: 'window.SysAiAvatarClassic={};', mesh: '{"v":5}' });
  assert.strictEqual(loadAvatarPack(pack, crypto.randomBytes(32)), null, 'another key (another build) cannot open it');
  assert.strictEqual(loadAvatarPack(pack, null), null, 'no key (built from source): no avatar');
  assert.ok(!fs.readFileSync(pack).includes('SysAiAvatarClassic'), 'nothing readable in the file');
  fs.writeFileSync(pack, 'plain text is not a pack');
  assert.strictEqual(loadAvatarPack(pack, key), null);

  const chat = new WebChat({ onText() {}, onButton: () => true });
  chat.avatar = { js: 'window.SysAiAvatarClassic={};', mesh: '{"v":5}' };
  const port = await chat.start();
  try {
    assert.strictEqual((await req(port, '/sab/avatar.js')).status, 403, 'not without the session cookie');
    const u = new URL(chat.url());
    const cookie = String((await req(port, u.pathname + u.search)).headers['set-cookie']).split(';')[0];
    const page = await req(port, '/', { cookie });
    assert.match(page.body, /href="https:\/\/sysaibrain\.com"/, 'attribution link');
    assert.match(page.body, /<canvas id="avatarCanvas">/);
    assert.match(page.body, /<script src="\/sab\/avatar\.js">/);
    assert.strictEqual((await req(port, '/sab/avatar.js', { cookie })).body, 'window.SysAiAvatarClassic={};');
    assert.strictEqual((await req(port, '/api/avatar/mesh', { cookie })).body, '{"v":5}');
  } finally {
    chat.stop();
  }
  const bare = new WebChat({ onText() {}, onButton: () => true });
  bare.avatar = null;
  const p2 = await bare.start();
  try {
    const u = new URL(bare.url());
    const cookie = String((await req(p2, u.pathname + u.search)).headers['set-cookie']).split(';')[0];
    const page = await req(p2, '/', { cookie });
    assert.doesNotMatch(page.body, /sab\/avatar\.js/, 'no avatar in builds without the pack');
    assert.match(page.body, /sysaibrain\.com/, 'the link is there anyway');
    assert.strictEqual((await req(p2, '/sab/avatar.js', { cookie })).status, 404);
  } finally {
    bare.stop();
  }
});
