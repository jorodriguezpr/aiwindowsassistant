// AiWindowsAssistant
// Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
// GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
//
// 1.7.0: /tasks (what the AI is doing) and /cancel (stop it, process trees included).
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwa-test-'));
process.env.CLAUDE_WORKSPACE = os.tmpdir();
process.env.DEFAULT_CWD = os.tmpdir();
process.env.TOAST_NOTIFICATIONS = 'false';
process.env.AI_PROVIDER = 'ollama';
process.env.AI_MODEL = 'test-model';

const dist = path.join(__dirname, '..', 'dist');
const A = require(path.join(dist, 'core', 'Activity'));
const { execKillable } = require(path.join(dist, 'utils', 'proc'));
const { Orchestrator } = require(path.join(dist, 'core', 'Orchestrator'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('cancel targets: your chat, one item, everything', () => {
  const mine = A.startJob(1, 'task', 'Claude Code', 'fix the readme');
  const other = A.startJob(2, 'task', 'tool', 'health report');
  const worker = A.startJob(-99, 'worker', 'Ollama Cloud', 'BJavaDecompiler delegation x');
  A.stepJob(mine, '🤖 Claude Code:\nBash: npm test');
  assert.strictEqual(A.runningJobs().length, 3);
  assert.match(mine.step, /Bash: npm test/);

  let r = A.cancelWork(1);
  assert.deepStrictEqual(r.jobs.map((j) => j.id), [mine.id], 'only my chat');
  assert.ok(mine.controller.signal.aborted && !other.controller.signal.aborted);

  r = A.cancelWork({ id: other.id });
  assert.deepStrictEqual(r.jobs.map((j) => j.id), [other.id], 'one item by number');

  const q = A.addQueued(1, 'open bluetooth settings');
  r = A.cancelWork('all');
  assert.deepStrictEqual(r.jobs.map((j) => j.id), [worker.id]);
  assert.deepStrictEqual(r.queued.map((x) => x.id), [q.id]);
  assert.ok(q.cancelled && worker.controller.signal.aborted);
  assert.strictEqual(A.runningJobs().length + A.queuedWork().length, 0);
  assert.strictEqual(A.ago(75_000), '1m 15s');
});

test('the queue: cancelled work never starts', async () => {
  const o = new Orchestrator();
  const ran = [];
  let release;
  const first = o.submit(7, () => new Promise((r) => (release = r)).then(() => ran.push('first')), 'first');
  const second = o.submit(7, async () => ran.push('second'), 'second');
  await sleep(50);
  assert.deepStrictEqual(A.queuedWork().map((q) => q.label), ['second'], 'listed while waiting');
  A.cancelWork(7);
  release();
  await Promise.all([first, second]);
  assert.deepStrictEqual(ran, ['first'], 'the queued one was dropped');
  assert.strictEqual(A.queuedWork().length, 0);
});

const pingRunning = () => {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq PING.EXE', '/FO', 'CSV', '/NH']).toString().toLowerCase().includes('ping.exe');
  } catch {
    return false;
  }
};

test('cancelling a command kills its whole process tree', { skip: process.platform !== 'win32' }, async () => {
  const before = pingRunning();
  const ctl = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ctl.abort(), 1500);
  // PowerShell starts ping.exe: Node's own kill would leave ping running
  const r = await execKillable('ping -n 60 127.0.0.1', { shell: 'powershell.exe', windowsHide: true, timeout: 90000 }, ctl.signal);
  assert.ok(r.cancelled);
  assert.ok(Date.now() - t0 < 15000, 'stopped long before the 60 s ping would end');
  await sleep(500);
  if (!before) assert.ok(!pingRunning(), 'the child ping.exe is gone too');
});

test('the assistant engine stops between steps', async () => {
  // a model that keeps asking for a tool, forever
  let calls = 0;
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `c${calls}`, function: { name: 'get_system_info', arguments: '{}' } }] } }] }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  const { config } = require(path.join(dist, 'config'));
  config.dataDir = DATA;
  config.ai.ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const { AgentLoop } = require(path.join(dist, 'core', 'AgentLoop'));
  const { AIProvider } = require(path.join(dist, 'providers', 'AIProvider'));
  const { AIToolExecutor } = require(path.join(dist, 'tools', 'AITools'));
  const ctl = new AbortController();
  const steps = [];
  const loop = new AgentLoop(new AIProvider(), new AIToolExecutor());
  const run = loop.run(4242, 'look around forever', { chatId: 4242, claudeBridge: {} }, {
    sendProgress: async (t) => {
      steps.push(t);
      if (steps.length === 2) ctl.abort();
    },
    requestApproval: async () => false,
    signal: ctl.signal,
  });
  const r = await run;
  fake.close();
  assert.strictEqual(r.response, '🛑 Cancelled.');
  assert.ok(calls <= 3, `stopped after ${calls} model calls`);
});
