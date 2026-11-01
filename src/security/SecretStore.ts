/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Secrets at rest and in child processes.
 *
 * At rest: `AiWindowsAssistant --protect-secrets` (or `npm run protect-secrets`) rewrites every
 * secret in .env as `dpapi:<base64>` — encrypted with Windows DPAPI for the current user, so the
 * file is useless to another Windows account or on another PC. They are decrypted in memory at
 * start-up. Plain values still work (with a warning in the log and in /doctor).
 *
 * In child processes: every command the assistant runs (execute_command, sysadmin tools,
 * launched programs, Claude Code itself and whatever IT runs) used to inherit all of .env —
 * `echo $env:TELEGRAM_BOT_TOKEN` printed the bot token. childEnv() hands them a copy without
 * the secrets.
 *
 * Must not import config.ts: config.ts calls decryptDpapiEnv() while it is being built.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

/** .env keys that hold secrets. */
export const SECRET_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'ANTHROPIC_API_KEY',
  'AI_API_KEY',
  'OLLAMA_CLOUD_API_KEY',
  'EMAIL_SMTP_PASS',
  'ESCALATION_WORKER_API_KEY',
  'BJAVADECOMPILER_WORKER_API_KEY',
];

const PREFIX = 'dpapi:';
/** Problems found while decrypting at start-up (logged by index.ts once the logger exists). */
export const secretWarnings: string[] = [];

// Values travel as base64 both ways so PowerShell's console code page can't mangle them.
const PS_PROTECT = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = @(foreach ($v in $in) { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($v), $null, 'CurrentUser')) })
ConvertTo-Json -InputObject $out -Compress`;
const PS_UNPROTECT = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = @(foreach ($v in $in) { try { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v), $null, 'CurrentUser')) } catch { '' } })
ConvertTo-Json -InputObject $out -Compress`;

function runDpapi(script: string, values: string[]): string[] {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(values),
    windowsHide: true,
    timeout: 30000,
  }).toString().trim();
  const parsed = JSON.parse(out) as string[] | string;
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Encrypt plain-text values with DPAPI (current user). */
export function protectValues(plain: string[]): string[] {
  if (plain.length === 0) return [];
  return runDpapi(PS_PROTECT, plain.map((v) => Buffer.from(v, 'utf8').toString('base64'))).map((b) => PREFIX + b);
}

/** Decrypt dpapi: values; '' for one that can't be decrypted (another user / another PC). */
export function unprotectValues(encrypted: string[]): string[] {
  if (encrypted.length === 0) return [];
  return runDpapi(PS_UNPROTECT, encrypted.map((v) => v.slice(PREFIX.length))).map((b) => (b ? Buffer.from(b, 'base64').toString('utf8') : ''));
}

/** Replace every dpapi: value in process.env with its plain text, in memory only. */
export function decryptDpapiEnv(): void {
  const keys = Object.keys(process.env).filter((k) => (process.env[k] || '').startsWith(PREFIX));
  if (keys.length === 0) return;
  try {
    const plain = unprotectValues(keys.map((k) => process.env[k] as string));
    keys.forEach((k, i) => {
      process.env[k] = plain[i];
      if (!plain[i]) secretWarnings.push(`${k} could not be decrypted (encrypted by another Windows user or PC?) — set it again`);
    });
  } catch (err) {
    // fail closed: an undecryptable secret is treated as not set, never as its ciphertext
    for (const k of keys) process.env[k] = '';
    secretWarnings.push(`DPAPI decryption failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — secrets treated as not set`);
  }
}

/** Secret keys that are set in .env as plain text. */
export function plaintextSecrets(envPath: string): string[] {
  if (!fs.existsSync(envPath)) return [];
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  return SECRET_KEYS.filter((k) => parsed[k] && !parsed[k].startsWith(PREFIX));
}

/** Rewrite .env with every plain secret encrypted. Returns the keys it protected. */
export function protectEnvFile(envPath: string): string[] {
  if (!fs.existsSync(envPath)) throw new Error(`${envPath} not found`);
  const todo = plaintextSecrets(envPath);
  if (todo.length === 0) return [];
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  const encrypted = protectValues(todo.map((k) => parsed[k]));
  // round-trip check before touching the file: never leave a secret we can't read back
  const back = unprotectValues(encrypted);
  todo.forEach((k, i) => {
    if (back[i] !== parsed[k]) throw new Error(`round-trip check failed for ${k} — .env left unchanged`);
  });
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  const out = lines.map((line) => {
    const m = /^(\s*)([A-Z0-9_]+)(\s*=\s*)(.*)$/.exec(line);
    if (!m) return line;
    const i = todo.indexOf(m[2]);
    return i < 0 ? line : `${m[1]}${m[2]}${m[3]}${encrypted[i]}`;
  });
  const tmp = envPath + '.tmp';
  fs.writeFileSync(tmp, out.join('\r\n'));
  fs.renameSync(tmp, envPath);
  return todo;
}

/** A copy of process.env for child processes, without this app's secrets. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SECRET_KEYS) delete env[k];
  delete env.AIWA_APPROVAL_TOKEN;
  return { ...env, ...extra };
}
