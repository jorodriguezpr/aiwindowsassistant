/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * /doctor — one message that says whether everything this assistant depends on works:
 * settings, secrets, Claude Code CLI, the approval gate (and that it refuses requests without
 * its token), the command policy, the AI provider, email, workspace, database, autostart.
 * Read-only: it sends no email, writes no file outside the OS temp folder, runs nothing risky.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { config, validateConfig, ENV_PATH, ProviderName } from '../config';
import { plaintextSecrets, secretWarnings, childEnv } from '../security/SecretStore';
import { classifyCommand } from '../security/CommandPolicy';
import { getDb } from '../db/Database';
import { isAutostartEnabled } from '../utils/autostart';
import { helperState } from '../elevated/client';
import type { ClaudeCodeBridge } from '../tools/ClaudeCodeBridge';
import type { ApprovalHookServer } from '../tools/ApprovalHookServer';

type Level = 'ok' | 'warn' | 'fail' | 'info';
interface Check {
  level: Level;
  text: string;
}
const ICON: Record<Level, string> = { ok: '🟢', warn: '🟡', fail: '🔴', info: 'ℹ️' };

function postStatus(port: number, token: string | null, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const headers: Record<string, string | number> = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: '/approve', method: 'POST', headers, timeout: 5000 }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let json: Record<string, unknown> | null = null;
        try {
          json = JSON.parse(out);
        } catch {
          /* 401 has no body */
        }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => req.destroy());
    req.write(data);
    req.end();
  });
}

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function providerCheck(provider: ProviderName): Promise<Check> {
  try {
    if (provider === 'anthropic') {
      if (!config.ai.anthropicApiKey) return { level: 'warn', text: 'AI provider anthropic: no API key (only the Claude Code engine will work)' };
      await axios.get('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': config.ai.anthropicApiKey, 'anthropic-version': '2023-06-01' },
        timeout: 8000,
      });
    } else if (provider === 'ollama-cloud') {
      await axios.get(`${config.ai.ollamaCloudBaseUrl}/api/tags`, { headers: { Authorization: `Bearer ${config.ai.ollamaCloudApiKey}` }, timeout: 8000 });
    } else {
      await axios.get(`${config.ai.ollamaBaseUrl}/api/tags`, { timeout: 5000 });
    }
    return { level: 'ok', text: `AI provider ${provider}: reachable` };
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    return { level: 'fail', text: `AI provider ${provider}: ${status === 401 || status === 403 ? 'key refused' : status ? `HTTP ${status}` : 'not reachable'}` };
  }
}

function claudeVersion(cli: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cli, ['--version'], { timeout: 15000, windowsHide: true, env: childEnv(), shell: /\.(cmd|bat)$/i.test(cli) }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim().split('\n')[0])
    );
  });
}

export async function runDoctor(claudeBridge: ClaudeCodeBridge, approvalServer: ApprovalHookServer | null, provider: ProviderName): Promise<string> {
  const checks: Check[] = [];
  const add = (level: Level, text: string) => checks.push({ level, text });

  // settings + secrets
  const problems = validateConfig();
  if (problems.length === 0) add('ok', 'Settings (.env): complete');
  for (const p of problems) add('warn', p);
  for (const w of secretWarnings) add('fail', w);
  const plain = plaintextSecrets(ENV_PATH);
  if (plain.length) add('warn', `Secrets stored as plain text in .env: ${plain.join(', ')} — run "AiWindowsAssistant --protect-secrets" (or npm run protect-secrets)`);
  else add('ok', 'Secrets in .env: encrypted with Windows DPAPI (or none set)');

  // Claude Code
  const cli = claudeBridge.resolveCliPath();
  if (!cli) add('fail', 'Claude Code CLI: not found (npm install -g @anthropic-ai/claude-code, then run "claude" once to log in)');
  else {
    const v = await claudeVersion(cli);
    add(v ? 'ok' : 'warn', v ? `Claude Code CLI: ${v}` : `Claude Code CLI found but did not answer --version: ${cli}`);
  }

  // approval gate
  if (!approvalServer || !approvalServer.port) add('fail', 'Approval gate: not running — Claude Code tool calls are NOT checked');
  else {
    const noToken = await postStatus(approvalServer.port, null, { chatId: 0, toolName: 'Read', toolInput: { file_path: 'x' } });
    const withToken = await postStatus(approvalServer.port, approvalServer.token, { chatId: 0, toolName: 'Read', toolInput: { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') } });
    if (noToken.status === 401 && withToken.json?.decision === 'deny') add('ok', `Approval gate: running (port ${approvalServer.port}), refuses requests without its token, blocks protected files`);
    else add('fail', `Approval gate: unexpected answers (without token: HTTP ${noToken.status}; protected file: ${String(withToken.json?.decision)})`);
  }

  // command policy self-test
  const expect: [string, string][] = [
    ['Get-Process | Sort-Object CPU -Descending | Select-Object -First 5', 'allow'],
    ['Remove-Item C:\\temp\\x.txt', 'ask'],
    ['powershell -enc SQBFAFgA', 'deny'],
  ];
  const wrong = expect.filter(([c, v]) => classifyCommand(c).verdict !== v);
  add(wrong.length ? 'fail' : 'ok', wrong.length ? `Command policy self-test failed: ${wrong.map(([c]) => c).join(' | ')}` : 'Command policy: read-only commands run, everything else asks, attacks are blocked');
  add('info', `Trusted commands (no approval): ${config.security.trustedCommands.length ? config.security.trustedCommands.join(', ') : 'none'}${config.security.sensitivePaths.length ? ` · extra protected paths: ${config.security.sensitivePaths.length}` : ''}`);

  // AI provider, email
  checks.push(await providerCheck(provider));
  if (!config.email.host) add('info', 'Email: not configured');
  else {
    try {
      const t = nodemailer.createTransport({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.secure,
        auth: { user: config.email.user, pass: config.email.pass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
      });
      await t.verify();
      add('ok', `Email: ${config.email.host} accepts the login`);
    } catch (err) {
      add('fail', `Email: ${config.email.host} — ${err instanceof Error ? err.message.split('\n')[0].slice(0, 120) : 'failed'}`);
    }
  }

  // folders, database, autostart
  for (const [label, dir] of [['Workspace (CLAUDE_WORKSPACE)', config.claude.workspace], ['Default folder (DEFAULT_CWD)', config.assistant.defaultCwd]] as const) {
    if (!fs.existsSync(dir)) add('fail', `${label}: ${dir} does not exist`);
    else add(writable(dir) ? 'ok' : 'warn', `${label}: ${dir}${writable(dir) ? '' : ' (not writable)'}`);
  }
  try {
    getDb().prepare('SELECT 1').get();
    add(writable(config.dataDir) ? 'ok' : 'fail', `Database: OK${writable(config.dataDir) ? '' : ` but ${config.dataDir} is not writable`}`);
  } catch (err) {
    add('fail', `Database: ${err instanceof Error ? err.message : String(err)}`);
  }
  add('info', `Start with Windows: ${isAutostartEnabled() ? 'on' : 'off'}`);

  // 1.4.0: administrator helper + Windows notifications
  const helper = helperState();
  if (!helper.running) add('info', 'Administrator helper: not installed (Windows updates, BitLocker, restore points… need it) — /admin explains how');
  else if (!helper.admin) add('fail', 'Administrator helper: running WITHOUT administrator rights — re-install it from an administrator prompt');
  else add(helper.outdated ? 'warn' : 'ok', `Administrator helper: running as administrator${helper.outdated ? ' — outdated, re-run the install' : ''}`);
  add(config.toast.enabled ? 'ok' : 'info', `Windows notifications: ${config.toast.enabled ? 'on (approvals can be answered at the PC too)' : 'off (TOAST_NOTIFICATIONS=false)'}`);

  const worst = checks.some((c) => c.level === 'fail') ? '🔴 Problems found' : checks.some((c) => c.level === 'warn') ? '🟡 Working, with warnings' : '🟢 All good';
  return `🩺 Doctor — ${worst}\n\n${checks.map((c) => `${ICON[c.level]} ${c.text}`).join('\n')}`;
}
