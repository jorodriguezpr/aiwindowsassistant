/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Inside a pkg-packaged binary, __dirname resolves into pkg's read-only virtual
// snapshot filesystem, not the real directory the .exe lives in on disk — any
// writable state (data/, logs/, .env, and the loose scripts/claude-approval-hook.js
// the Claude Code hook invokes externally) must resolve against the real exe
// location instead. `process.pkg` is set by the pkg runtime when packaged.
const IS_PKG = !!(process as unknown as { pkg?: unknown }).pkg;
const PROJECT_ROOT = IS_PKG ? path.dirname(process.execPath) : path.resolve(__dirname, '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

export type ProviderName = 'anthropic' | 'ollama-cloud' | 'ollama';

function env(key: string, def = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
}

function envInt(key: string, def: number): number {
  const v = parseInt(process.env[key] || '', 10);
  return Number.isFinite(v) ? v : def;
}

function envFloat(key: string, def: number): number {
  const v = parseFloat(process.env[key] || '');
  return Number.isFinite(v) ? v : def;
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-sonnet-4-6',
  'ollama-cloud': 'nemotron-3-super',
  ollama: 'qwen2.5-coder:latest',
};

function resolveProvider(): ProviderName {
  const p = env('AI_PROVIDER', 'anthropic').toLowerCase() as ProviderName;
  if (!['anthropic', 'ollama-cloud', 'ollama'].includes(p)) {
    throw new Error(`Invalid AI_PROVIDER "${p}". Use: anthropic | ollama-cloud | ollama`);
  }
  return p;
}

export const config = {
  projectRoot: PROJECT_ROOT,
  dataDir: path.join(PROJECT_ROOT, 'data'),
  logDir: path.join(PROJECT_ROOT, 'logs'),
  assetsDir: path.join(PROJECT_ROOT, 'assets'),

  telegram: {
    token: env('TELEGRAM_BOT_TOKEN'),
    allowedUsers: env('TELEGRAM_ALLOWED_USERS')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  },

  ai: {
    provider: resolveProvider(),
    model: env('AI_MODEL'), // empty -> provider default
    maxTokens: envInt('AI_MAX_TOKENS', 4096),
    temperature: envFloat('AI_TEMPERATURE', 0.7),
    anthropicApiKey: env('ANTHROPIC_API_KEY') || env('AI_API_KEY'),
    ollamaCloudApiKey: env('OLLAMA_CLOUD_API_KEY') || env('AI_API_KEY'),
    ollamaCloudBaseUrl: env('OLLAMA_CLOUD_BASE_URL', 'https://ollama.com'),
    ollamaBaseUrl: env('OLLAMA_BASE_URL', 'http://localhost:11434'),
  },

  claude: {
    cliPath: env('CLAUDE_CODE_PATH'),
    workspace: env('CLAUDE_WORKSPACE', 'C:\\PhpProjects'),
    // bypassPermissions, not acceptEdits: acceptEdits still makes Claude Code *ask*
    // permission for Bash calls, which headless -p mode has no TTY to answer — it
    // just declines and explains instead of running anything. The PreToolUse hook
    // (ApprovalHookServer) is the real gate now and fires regardless of this mode.
    permissionMode: env('CLAUDE_PERMISSION_MODE', 'bypassPermissions'),
    timeoutMs: envInt('CLAUDE_TIMEOUT_MS', 600000),
  },

  assistant: {
    defaultCwd: env('DEFAULT_CWD', 'C:\\PhpProjects'),
    maxIterations: envInt('AGENT_MAX_ITERATIONS', 240),
    // Estimate threshold (tokens) before summarizing history, same idea as AiAgentAssistant
    summarizeThresholdTokens: 50000,
    historyKeepMessages: 10,
    documentsDir: env('DOCUMENTS_DIR', path.join(os.homedir(), 'Documents', 'AiWindowsAssistant')),
  },

  email: {
    host: env('EMAIL_SMTP_HOST'),
    port: envInt('EMAIL_SMTP_PORT', 587),
    secure: env('EMAIL_SMTP_SECURE', 'false').toLowerCase() === 'true',
    user: env('EMAIL_SMTP_USER'),
    pass: env('EMAIL_SMTP_PASS'),
    from: env('EMAIL_FROM'),
  },

  autoStart: env('AUTO_START', 'false').toLowerCase() === 'true',

  log: {
    level: env('LOG_LEVEL', 'info'),
    redactionDisabled: env('LOG_REDACTION_DISABLED', 'false').toLowerCase() === 'true',
  },

  defaultModel(provider: ProviderName): string {
    return DEFAULT_MODELS[provider];
  },
};

export function ensureDirectories(): void {
  for (const dir of [config.dataDir, config.logDir, config.assetsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function validateConfig(): string[] {
  const problems: string[] = [];
  if (!config.telegram.token) problems.push('TELEGRAM_BOT_TOKEN is not set');
  if (config.telegram.allowedUsers.length === 0)
    problems.push(
      'TELEGRAM_ALLOWED_USERS is not set — the bot will only reply to /start (to reveal your ' +
        'chat ID) until you add it to .env and restart. This is intentional fail-closed behavior.'
    );
  if (config.ai.provider === 'anthropic' && !config.ai.anthropicApiKey)
    problems.push('ANTHROPIC_API_KEY is not set (AI_PROVIDER=anthropic)');
  if (config.ai.provider === 'ollama-cloud' && !config.ai.ollamaCloudApiKey)
    problems.push('OLLAMA_CLOUD_API_KEY is not set (AI_PROVIDER=ollama-cloud)');
  if (!fs.existsSync(config.claude.workspace))
    problems.push(`CLAUDE_WORKSPACE does not exist: ${config.claude.workspace}`);
  if (!fs.existsSync(config.assistant.defaultCwd))
    problems.push(`DEFAULT_CWD does not exist: ${config.assistant.defaultCwd}`);
  return problems;
}

export const HOSTNAME = os.hostname();
