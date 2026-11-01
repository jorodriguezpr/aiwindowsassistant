/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { config, ensureDirectories, validateConfig, HOSTNAME, ENV_PATH } from './config';
import { protectEnvFile, plaintextSecrets, secretWarnings } from './security/SecretStore';
import { installHelper, uninstallHelper, queueDir } from './elevated/client';
import { runElevatedHelper } from './elevated/helper';
import { writeRuntimeFile, forwardToastAction } from './services/ToastService';
import { runMcpServer } from './mcp/McpServer';
import { uninstallCleanup } from './utils/uninstall';
import { WebChat } from './gateways/WebChat';
import { AlertService } from './services/AlertService';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger';
import { TelegramGateway } from './gateways/TelegramGateway';
import { ClaudeCodeBridge } from './tools/ClaudeCodeBridge';
import { ApprovalHookServer } from './tools/ApprovalHookServer';
import { EscalationPollService } from './services/EscalationPollService';
import { BJavaDecompilerPollService } from './services/BJavaDecompilerPollService';
import { Orchestrator } from './core/Orchestrator';
import { TrayIcon } from './tray/TrayIcon';
import { addAutostart, isAutostartEnabled } from './utils/autostart';
import { getDb } from './db/Database';
import { getRunningPendingTasks, finishPendingTask } from './db/ChatStateStore';

function appVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(config.projectRoot, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '1.5.0';
  }
}

async function main(): Promise<void> {
  // started by Claude Code (--mcp-config): this app's tools over MCP. First, and nothing may print to stdout.
  if (process.argv.includes('--mcp-server')) {
    runMcpServer(appVersion());
    return;
  }
  // `AiWindowsAssistant --protect-secrets`: encrypt the secrets in .env with DPAPI, then exit
  if (process.argv.includes('--protect-secrets')) {
    const done = protectEnvFile(ENV_PATH);
    console.log(done.length ? `Encrypted with Windows DPAPI (this user, this PC): ${done.join(', ')}` : 'No plain-text secrets left in .env.');
    return;
  }
  // administrator helper (src/elevated): install/remove from an admin prompt; the pkg .exe also runs it
  if (process.argv.includes('--install-helper')) {
    console.log(installHelper());
    return;
  }
  if (process.argv.includes('--uninstall-cleanup')) {
    const removed = uninstallCleanup();
    console.log(removed.length ? `Removed: ${removed.join(', ')}` : 'Nothing of this install was registered.');
    return;
  }
  if (process.argv.includes('--uninstall-helper')) {
    console.log(uninstallHelper());
    return;
  }
  const helperArg = process.argv.indexOf('--elevated-helper');
  if (helperArg >= 0) {
    await runElevatedHelper(process.argv[helperArg + 1] || queueDir());
    return; // keeps running on its timers
  }
  // a click on a Windows notification button (aiwa://approve/<nonce>), forwarded to the running app
  const toastArg = process.argv.indexOf('--toast-action');
  if (toastArg >= 0) {
    await forwardToastAction(process.argv[toastArg + 1] || '');
    return;
  }
  ensureDirectories();
  const logger = createLogger();
  logger.info({ host: HOSTNAME, pid: process.pid }, 'AiWindowsAssistant starting');

  getDb(); // open + migrate before anything else touches persisted state
  const interrupted = getRunningPendingTasks();
  if (interrupted.length > 0) {
    logger.warn({ count: interrupted.length }, 'found tasks still marked running from a previous session — likely an unclean shutdown');
  }

  const problems = validateConfig();
  for (const p of problems) logger.warn(p);
  for (const w of secretWarnings) logger.warn(w);
  const plain = plaintextSecrets(ENV_PATH);
  if (plain.length > 0) logger.warn({ keys: plain }, 'secrets stored as plain text in .env — run with --protect-secrets to encrypt them');
  if (!config.telegram.token) {
    // console.error (not logger.error) — logger writes async and process.exit()
    // right after can race the stream ("sonic boom is not ready yet").
    console.error('TELEGRAM_BOT_TOKEN missing — copy .env.example to .env and fill it in. Exiting.');
    process.exitCode = 1;
    return;
  }

  // Optional autostart registration (Windows equivalent of systemd enable)
  if (config.autoStart && !isAutostartEnabled()) {
    try {
      addAutostart();
      logger.info('autostart registered in HKCU Run key');
    } catch (err) {
      logger.warn({ err }, 'failed to register autostart');
    }
  }

  const orchestrator = new Orchestrator();
  const claudeBridge = new ClaudeCodeBridge(logger);
  const gateway = new TelegramGateway(claudeBridge, orchestrator, logger);

  // Local approval-gate server: lets Claude Code's own destructive tool calls
  // (via the PreToolUse hook in scripts/claude-approval-hook.js) go through the
  // same Telegram approve/deny flow AgentLoop's tools already use.
  const approvalServer = new ApprovalHookServer(gateway.requestApproval, logger);
  try {
    const port = await approvalServer.start();
    claudeBridge.setApprovalHook(port, approvalServer.token);
    gateway.setApprovalServer(approvalServer);
    writeRuntimeFile(port); // where --toast-action finds this process
  } catch (err) {
    logger.warn({ err }, 'approval hook server failed to start — Claude Code destructive actions will not be gated');
  }

  if (!claudeBridge.isAvailable()) {
    logger.warn('Claude Code CLI not found — delegate_to_claude_code and /claude will report an error. Install: npm install -g @anthropic-ai/claude-code');
  }

  // Fleet Guardian escalation worker — polls SysAdminCenterHCP for pending "ask Claude Code"
  // requests it can't reach this PC to push directly (no inbound connectivity). No-ops if
  // SYSADMIN_CENTER_HCP_URL / ESCALATION_WORKER_API_KEY aren't configured.
  const escalationPoller = new EscalationPollService(claudeBridge, gateway, logger);
  escalationPoller.start();

  // BJavaDecompiler AI delegation worker — polls BJavaDecompiler for prompts its own AI
  // reconstruction/remediation pass hands off to this desktop's Claude Code (AI_PROVIDER=
  // ai-delegation there). No-ops if BJAVADECOMPILER_URL / BJAVADECOMPILER_WORKER_API_KEY
  // aren't configured. No Telegram approval gate — these prompts are pure text reconstruction
  // with zero real-world side effects, unlike a Guardian escalation.
  const bjavaDecompilerPoller = new BJavaDecompilerPollService(claudeBridge, gateway, logger);
  bjavaDecompilerPoller.start();

  // Tray icon
  // 1.5.0: chat window at the PC (hotkey / tray) and proactive alerts
  let webChat: WebChat | null = null;
  if (config.chatWindow.enabled && config.telegram.allowedUsers.length > 0) {
    webChat = new WebChat({ onText: (t) => gateway.injectOwnerText(t), onButton: (d) => gateway.answerButton(d, 'chat window') !== null }, logger);
    try {
      await webChat.start();
      gateway.webChat = webChat;
    } catch (err) {
      logger.warn({ err }, 'chat window failed to start');
      webChat = null;
    }
  }
  const alerts = new AlertService(async (text) => {
    await gateway.notifyOwner(text);
    gateway.toast.notify('AiWindowsAssistant alert', text);
  }, logger);
  gateway.alerts = alerts;

  const tray = new TrayIcon(
    {
      onOpenChat: webChat ? () => webChat?.open() : undefined,
      onPauseToggle: () => {
        gateway.setPaused(!gateway.paused);
        logger.info({ paused: gateway.paused }, 'pause toggled from tray');
        return gateway.paused;
      },
      onTestMessage: () => {
        void gateway.notifyOwner('🔔 Test from AiWindowsAssistant tray. Bot is alive!');
      },
      onQuit: () => {
        void shutdown('tray quit');
      },
    },
    logger
  );

  gateway.onPauseChanged = (paused) => tray.setPaused(paused);

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'shutting down');
    try {
      await gateway.notifyOwner(`🔌 AiWindowsAssistant stopping (${reason}).`);
    } catch {
      /* best effort */
    }
    gateway.stop(reason);
    approvalServer.stop();
    webChat?.stop();
    alerts.stop();
    escalationPoller.stop();
    bjavaDecompilerPoller.stop();
    await tray.kill();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandled rejection');
  });

  await gateway.launch();
  webChat?.startHotkey();
  alerts.start();
  tray.setStatus('AI: ready');
  await tray.start();

  await gateway.notifyOwner(
    `✅ *AiWindowsAssistant* is running on ${HOSTNAME}.\nWhat task would you like to delegate?`
  );

  if (interrupted.length > 0) {
    const lines = interrupted.map((t) => `• #${t.id} (chat ${t.chatId}, started ${t.createdAt}): ${t.description}`);
    await gateway.notifyOwner(
      `⚠️ Found ${interrupted.length} task(s) still marked "running" from before the last restart — ` +
        `likely lost to an unclean shutdown, not resumed automatically:\n${lines.join('\n')}`
    );
    for (const t of interrupted) finishPendingTask(t.id, 'failed');
  }

  logger.info('AiWindowsAssistant ready');
}

main().catch((err) => {
  // Synchronous write only — no async logger/streams before exit.
  console.error('Fatal startup error:', err);
  process.exitCode = 1;
});
