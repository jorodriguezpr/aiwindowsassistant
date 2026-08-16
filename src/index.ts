/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { config, ensureDirectories, validateConfig, HOSTNAME } from './config';
import { createLogger } from './logger';
import { TelegramGateway } from './gateways/TelegramGateway';
import { ClaudeCodeBridge } from './tools/ClaudeCodeBridge';
import { ApprovalHookServer } from './tools/ApprovalHookServer';
import { Orchestrator } from './core/Orchestrator';
import { TrayIcon } from './tray/TrayIcon';
import { addAutostart, isAutostartEnabled } from './utils/autostart';

async function main(): Promise<void> {
  ensureDirectories();
  const logger = createLogger();
  logger.info({ host: HOSTNAME, pid: process.pid }, 'AiWindowsAssistant starting');

  const problems = validateConfig();
  for (const p of problems) logger.warn(p);
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
    claudeBridge.setApprovalHookPort(port);
  } catch (err) {
    logger.warn({ err }, 'approval hook server failed to start — Claude Code destructive actions will not be gated');
  }

  if (!claudeBridge.isAvailable()) {
    logger.warn('Claude Code CLI not found — delegate_to_claude_code and /claude will report an error. Install: npm install -g @anthropic-ai/claude-code');
  }

  // Tray icon
  const tray = new TrayIcon(
    {
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
  tray.setStatus('AI: ready');
  await tray.start();

  await gateway.notifyOwner(
    `✅ *AiWindowsAssistant* is running on ${HOSTNAME}.\nWhat task would you like to delegate?`
  );
  logger.info('AiWindowsAssistant ready');
}

main().catch((err) => {
  // Synchronous write only — no async logger/streams before exit.
  console.error('Fatal startup error:', err);
  process.exitCode = 1;
});
