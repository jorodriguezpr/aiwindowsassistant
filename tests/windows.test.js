// AiWindowsAssistant
// Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
// GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
//
// 1.4.0 Windows features (run: npm test). Loads the compiled code in dist/ with a fixed environment.
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
const { findSettingsPage } = require(path.join(dist, 'tools', 'WindowsTools'));
const { RequestAnalyzer } = require(path.join(dist, 'core', 'RequestAnalyzer'));
const { toolCallDecision } = require(path.join(dist, 'tools', 'AITools'));
const { validateOp } = require(path.join(dist, 'elevated', 'ops'));
const { evaluate, score } = require(path.join(dist, 'services', 'HealthCheckService'));
const { parseTargets } = require(path.join(dist, 'services', 'CleanupService'));
const { ApprovalHookServer } = require(path.join(dist, 'tools', 'ApprovalHookServer'));

test('Settings pages by name', () => {
  assert.strictEqual(findSettingsPage('bluetooth').uri, 'ms-settings:bluetooth');
  assert.strictEqual(findSettingsPage('Windows Update').uri, 'ms-settings:windowsupdate');
  assert.strictEqual(findSettingsPage('change my wifi').uri, 'ms-settings:network-wifi');
  assert.strictEqual(findSettingsPage('default apps settings').uri, 'ms-settings:defaultapps');
  assert.strictEqual(findSettingsPage('flux capacitor'), null);
});

test('instant shortcuts (no AI)', () => {
  const a = new RequestAnalyzer();
  const t = (s) => a.analyze(s)?.tool;
  assert.strictEqual(t('open bluetooth settings'), 'open_settings');
  assert.strictEqual(t('display settings'), 'open_settings');
  assert.strictEqual(t('screenshot'), 'take_screenshot');
  assert.strictEqual(t('send me a screenshot'), 'take_screenshot');
  assert.strictEqual(t('free up space'), 'analyze_disk_space');
  assert.strictEqual(t('disk cleanup'), 'analyze_disk_space');
  assert.strictEqual(t('health check'), 'health_report');
  assert.strictEqual(t('install vlc'), 'apps_install');
  assert.notStrictEqual(t('install windows updates'), 'apps_install', 'not an app called "windows updates"');
  assert.strictEqual(t('update all apps'), 'apps_upgrade');
  assert.strictEqual(t('check for windows updates'), 'admin_task');
  assert.strictEqual(t('open notepad'), 'launch_program', 'program launch still works');
  assert.strictEqual(a.analyze('explain how bluetooth works'), null, 'a question is not a shortcut');
});

test('approval rules for the new tools', () => {
  const v = (n, a = {}) => toolCallDecision(n, a).verdict;
  assert.strictEqual(v('open_settings', { page: 'display' }), 'allow');
  assert.strictEqual(v('take_screenshot'), 'allow');
  assert.strictEqual(v('analyze_disk_space'), 'allow');
  assert.strictEqual(v('health_report'), 'allow');
  assert.strictEqual(v('apps_search', { query: 'vlc' }), 'allow');
  assert.strictEqual(v('apps_install', { app: 'vlc' }), 'ask');
  assert.strictEqual(v('apps_upgrade', { app: 'all' }), 'ask');
  assert.strictEqual(v('clean_up_disk', { targets: 'temp' }), 'ask');
  assert.match(toolCallDecision('clean_up_disk', { targets: 'temp,recycle_bin' }).reason, /Recycle Bin: emptied — PERMANENT/);
  assert.strictEqual(v('admin_task', { task: 'bitlocker_status' }), 'allow');
  assert.strictEqual(v('admin_task', { task: 'restore_point' }), 'allow');
  assert.strictEqual(v('admin_task', { task: 'windows_update_install' }), 'ask');
  assert.strictEqual(v('admin_task', { task: 'pagefile_fixed', param: '16384' }), 'ask');
});

test('the admin helper only accepts its fixed jobs with valid parameters', () => {
  assert.throws(() => validateOp('run_anything', 'calc.exe'), /Unknown admin task/);
  assert.throws(() => validateOp('restart_service', 'WinDefend'), /Only these services/);
  assert.strictEqual(validateOp('restart_service', 'spooler').param, 'Spooler');
  assert.throws(() => validateOp('pagefile_fixed', '500'), /between 2048 and 65536/);
  assert.throws(() => validateOp('pagefile_fixed', '16384; calc'), /between/);
  assert.throws(() => validateOp('winget_install', 'VLC; calc.exe'), /Not a winget package id/);
  assert.throws(() => validateOp('winget_install', '--override "x"'), /Not a winget package id/);
  assert.strictEqual(validateOp('winget_upgrade', 'ALL').param, 'all');
});

test('the helper process refuses old requests, and everything when it is not administrator', async () => {
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwa-queue-'));
  const child = spawn(process.execPath, [path.join(dist, 'elevated', 'helper.js'), queue], { stdio: 'ignore', windowsHide: true });
  try {
    const req = path.join(queue, 'requests');
    for (let i = 0; i < 40 && !fs.existsSync(path.join(queue, 'helper.alive.json')); i++) await new Promise((r) => setTimeout(r, 100));
    const alive = JSON.parse(fs.readFileSync(path.join(queue, 'helper.alive.json'), 'utf8'));
    const send = (id, body) => fs.writeFileSync(path.join(req, `${id}.json`), JSON.stringify(body));
    const answer = async (id) => {
      for (let i = 0; i < 50; i++) {
        const f = path.join(queue, 'responses', `${id}.json`);
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    send('a'.repeat(32), { id: 'a'.repeat(32), op: 'status', at: Date.now() - 10 * 60_000 });
    assert.match((await answer('a'.repeat(32))).error, /too old/);
    send('b'.repeat(32), { id: 'b'.repeat(32), op: 'status', at: Date.now() });
    const b = await answer('b'.repeat(32));
    if (alive.admin) assert.ok(b.ok, 'admin helper runs status');
    else assert.match(b.error, /not running as administrator/);
    fs.writeFileSync(path.join(req, 'not-a-request.json'), '{}');
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(fs.existsSync(path.join(req, 'not-a-request.json')), 'files with other names are ignored, not executed');
  } finally {
    child.kill();
    fs.rmSync(queue, { recursive: true, force: true });
  }
});

test('health rules and score', () => {
  const healthy = {
    drives: [{ name: 'C:', sizeGB: 476, freeGB: 120 }],
    physicalDisks: [{ name: 'NVMe', health: 'Healthy', media: 'SSD' }],
    rebootPending: false, uptimeDays: 2,
    defender: { realtime: true, signatureAgeDays: 0, quickScanAgeDays: 1, enabled: true },
    firewallOff: [], lastUpdateDays: 5, systemErrors24h: 3, unexpectedShutdowns7d: 0, memTotalGB: 16, memFreeGB: 6, startupPrograms: 8,
  };
  assert.strictEqual(score(evaluate(healthy, 'C: FullyEncrypted On 100')), 100);
  const sick = { ...healthy, drives: [{ name: 'C:', sizeGB: 476, freeGB: 2.3 }], defender: { ...healthy.defender, realtime: false }, firewallOff: ['Public'], rebootPending: true };
  const f = evaluate(sick, 'C: FullyDecrypted Off 0');
  assert.ok(f.some((x) => x.area === 'Disk' && x.severity === 'bad'));
  assert.ok(f.some((x) => x.area === 'Antivirus' && x.severity === 'bad'));
  assert.ok(f.some((x) => x.area === 'Encryption' && x.severity === 'warn'));
  assert.ok(score(f) < 50);
});

test('clean-up targets', () => {
  const ids = (s) => parseTargets(s).map((t) => t.id);
  assert.ok(!ids('all-safe').includes('recycle_bin') && !ids('all-safe').includes('old_installers'), 'all-safe never empties the bin or touches Downloads');
  assert.deepStrictEqual(ids('temp, npm_cache'), ['temp', 'npm_cache']);
  assert.throws(() => parseTargets('temp,system32'), /Unknown clean-up target/);
});

test('notification buttons: only the right nonce answers an approval', async () => {
  const seen = [];
  const server = new ApprovalHookServer(async () => false);
  server.onToastAction = (nonce, approve) => (nonce === 'c'.repeat(32) ? (seen.push(approve), true) : false);
  const port = await server.start();
  const post = (body) =>
    new Promise((resolve) => {
      const data = JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: '/toast', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => resolve(res.statusCode));
      req.end(data);
    });
  try {
    assert.strictEqual(await post({ nonce: 'd'.repeat(32), approve: true }), 404);
    assert.strictEqual(await post({ nonce: 'not-hex', approve: true }), 404);
    assert.strictEqual(await post({ nonce: 'c'.repeat(32), approve: true }), 204);
    assert.deepStrictEqual(seen, [true]);
  } finally {
    server.stop();
  }
});
