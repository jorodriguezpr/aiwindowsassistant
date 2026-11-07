// AiWindowsAssistant
// Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
// GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
//
// 1.7.1: /pause really pauses - one middleware check refuses every command, message, photo and
// approval button except the ones that only report or stop work.
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwa-test-'));
process.env.TELEGRAM_BOT_TOKEN = '123456:TEST-TOKEN-not-real';
process.env.TELEGRAM_ALLOWED_USERS = '4242';
process.env.CLAUDE_WORKSPACE = os.tmpdir();
process.env.DEFAULT_CWD = os.tmpdir();
process.env.TOAST_NOTIFICATIONS = 'false';
process.env.AI_PROVIDER = 'ollama';
process.env.AI_MODEL = 'test-model';

const dist = path.join(__dirname, '..', 'dist');
const { config } = require(path.join(dist, 'config'));
config.dataDir = DATA;
const { TelegramGateway, allowedWhilePaused } = require(path.join(dist, 'gateways', 'TelegramGateway'));

test('allowedWhilePaused: only report/stop commands and Deny', () => {
  for (const t of ['/resume', '/pause', '/status', '/help', '/tasks', '/cancel', '/cancel all', '/cancel 2', '/start', '/status@MyBot', '  /resume  '])
    assert.strictEqual(allowedWhilePaused(false, t), true, t);
  for (const t of ['/execute whoami', '/claude fix it', '/screenshot', '/cleanup run temp', '/apps install x', '/fix network', '/admin flushdns',
    '/settings', '/health', '/schedule add a daily 09:00 x', '/task do it', '/ai hi', '/provider anthropic', '/clear', '/resumex', 'hello', 'resume', ''])
    assert.strictEqual(allowedWhilePaused(false, t), false, t);
  assert.strictEqual(allowedWhilePaused(true, '', 'deny:abc'), true);
  for (const d of ['appr:abc', 'gr10:abc', '', 'xdeny:abc']) assert.strictEqual(allowedWhilePaused(true, '', d), false, d);
});

test('gateway: a paused bot runs nothing (commands, text, photos, Approve), still answers /status and Deny', async () => {
  const submitted = [];
  const orchestrator = { submit: (chatId, fn, label) => { submitted.push(label); return Promise.resolve(); } };
  const claudeBridge = { resolveCliPath: () => null, hasSession: () => false, clearSession: () => {} };
  const gw = new TelegramGateway(claudeBridge, orchestrator);
  const bot = gw.bot;
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'TestBot' };
  const calls = [];
  // Telegraf builds a new Telegram client per update - stub the class so nothing goes to the network
  const { Telegram } = require('telegraf');
  Telegram.prototype.callApi = async function (method, payload) { calls.push({ method, payload }); return { message_id: calls.length }; };
  bot.telegram.callApi = Telegram.prototype.callApi;
  const ran = [];
  gw.runToolDirect = async (chatId, name) => { ran.push(name); };
  gw.handleDelegatedText = async () => { ran.push('text'); };
  gw.handlePhoto = async () => { ran.push('photo'); };
  gw.answerButton = (data) => { ran.push('button ' + data); return data.startsWith('appr:'); };

  let uid = 1;
  const chat = { id: 4242, type: 'private' };
  const msg = (text) => bot.handleUpdate({ update_id: uid++, message: { message_id: uid, date: 0, chat, from: { id: 4242, is_bot: false, first_name: 'o' }, text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}) } });
  const photo = () => bot.handleUpdate({ update_id: uid++, message: { message_id: uid, date: 0, chat, from: { id: 4242, is_bot: false, first_name: 'o' }, photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }] } });
  const button = (data) => bot.handleUpdate({ update_id: uid++, callback_query: { id: String(uid), chat_instance: 'c', from: { id: 4242, is_bot: false, first_name: 'o' }, data,
    message: { message_id: 1, date: 0, chat, text: 'approve?' } } });
  const replies = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);

  await msg('/pause');
  assert.strictEqual(gw.paused, true);
  assert.match(replies().at(-1), /Paused/);

  for (const t of ['/execute whoami', '/claude do something', '/screenshot', '/cleanup', '/apps', '/fix network', '/admin flushdns', '/settings', '/health', 'open notepad'])
    await msg(t);
  await photo();
  await button('appr:x1');
  await button('gr10:x1');
  assert.deepStrictEqual(ran, [], 'nothing ran while paused');
  assert.deepStrictEqual(submitted, [], 'nothing was queued while paused');
  const pausedReplies = replies().filter((t) => /Bot is paused/.test(t));
  assert.strictEqual(pausedReplies.length, 11, 'every refused message got the paused reply');
  assert.ok(calls.filter((c) => c.method === 'answerCallbackQuery').every((c) => /paused/.test(c.payload.text)));

  await button('deny:x1');
  assert.deepStrictEqual(ran, ['button deny:x1'], 'Deny still works');
  await msg('/status');
  assert.match(replies().at(-1), /Status[\s\S]*paused/);

  await msg('/resume');
  assert.strictEqual(gw.paused, false);
  await msg('/screenshot');
  await msg('/execute whoami');
  assert.deepStrictEqual(submitted, ['Screenshot']);
  assert.deepStrictEqual(ran, ['button deny:x1', 'execute_command']);

  // chat window + Windows notification: Approve refused while paused, Deny allowed
  gw.answerButton = Object.getPrototypeOf(gw).answerButton.bind(gw);
  const settled = [];
  gw.settleApproval = (id, approved, via) => { settled.push(`${id} ${approved} ${via}`); return true; };
  gw.pendingApprovals.set('p1', { nonce: 'n1', chatId: 4242 });
  gw.setPaused(true);
  assert.strictEqual(gw.answerButton('appr:p1', 'chat window'), null);
  assert.strictEqual(gw.answerButton('gr10:p1', 'chat window'), null);
  assert.strictEqual(gw.handleToastAction('n1', true), false);
  assert.deepStrictEqual(settled, []);
  assert.strictEqual(gw.answerButton('deny:p1', 'chat window'), false);
  assert.strictEqual(gw.handleToastAction('n1', false), true);
  assert.deepStrictEqual(settled, ['p1 false chat window', 'p1 false this PC']);
  gw.setPaused(false);
  assert.strictEqual(gw.answerButton('appr:p1', 'chat window'), true);

  // tray toggle goes through the same flag
  gw.setPaused(true);
  await msg('/execute whoami');
  assert.deepStrictEqual(ran, ['button deny:x1', 'execute_command']);
});
