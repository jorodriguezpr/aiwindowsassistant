/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Standalone entry point invoked by Windows Task Scheduler (registered via SchedulerService.ts)
 * — independent of the tray app's process, so scheduled runs work whether or not the app is
 * currently open. This is what makes "scheduled/recurring automation" actually survive the app
 * not running, per the project's Windows-Task-Scheduler design decision.
 *
 * Always runs unattended: there is no live Telegram channel here to approve anything through —
 * a one-shot process has nothing listening for callback_query updates, whether or not the tray
 * app happens to also be running at the time. Rather than block forever or silently auto-approve,
 * every approval check in this context is a hard deny. Scheduled tasks are meant for read-only /
 * reporting-style prompts; if one tries something destructive it gets skipped, not executed.
 */
import { Telegraf } from 'telegraf';
import { config, ensureDirectories } from './config';
import { getScheduledTask, markScheduledTaskRun } from './db/ScheduleStore';
import { ClaudeCodeBridge } from './tools/ClaudeCodeBridge';
import { ApprovalHookServer } from './tools/ApprovalHookServer';
import { AgentLoop } from './core/AgentLoop';
import { AIProvider } from './providers/AIProvider';
import { AIToolExecutor } from './tools/AITools';
import { buildHealthReport, HEALTH_PROMPT } from './services/HealthCheckService';
import { gateToolCall } from './security/Gate';
import { MCP_TOOL_NAMES } from './mcp/McpServer';

async function main(id: number): Promise<void> {
  if (!Number.isFinite(id)) {
    console.error('Usage: scheduled-runner.js <taskId>');
    process.exit(1);
  }

  ensureDirectories();
  const task = getScheduledTask(id);
  if (!task || !task.enabled) {
    console.error(`Scheduled task ${id} not found or disabled`);
    process.exit(1);
  }

  const bot = new Telegraf(config.telegram.token);

  // /health weekly: no AI, just the read-only health report as a PDF
  if (task.prompt === HEALTH_PROMPT) {
    try {
      const rep = await buildHealthReport();
      await bot.telegram.sendDocument(task.chatId, { source: rep.pdfPath }, { caption: `⏰ ${task.name}\n${rep.summary}`.slice(0, 1000) });
    } catch (err) {
      await bot.telegram.sendMessage(task.chatId, `⏰ ${task.name} failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    }
    markScheduledTaskRun(id);
    process.exit(0);
  }

  // Shared, always-deny approval gate for the whole run — used both for a direct Claude Code
  // engine run and for the Ollama engine's own ClaudeCodeBridge instance (in case the model
  // decides to call delegate_to_claude_code as a sub-tool).
  const claudeBridge = new ClaudeCodeBridge();
  const approvalServer = new ApprovalHookServer(async () => false);
  try {
    claudeBridge.setApprovalHook(await approvalServer.start(), approvalServer.token);
    // Claude Code's MCP tool calls: read-only ones run, anything needing approval is denied (nobody is there)
    const executor = new AIToolExecutor();
    approvalServer.toolRunner = async (chatId, name, args) => {
      if (!MCP_TOOL_NAMES.has(name)) return { success: false, error: `tool ${name} is not available` };
      const gate = await gateToolCall(chatId, name, args, name, async () => false);
      if (!gate.ok) return { success: false, error: `${gate.error} (unattended scheduled run)` };
      return executor.execute(name, JSON.stringify(args), { chatId, claudeBridge, requestApproval: async () => false });
    };
  } catch {
    // If the hook server can't start, ClaudeCodeBridge falls back to no --settings hook at all —
    // acceptable here since bypassPermissions plus this script's own always-deny loop callback
    // (Ollama path) is still the safety net for the AITools.ts-level destructive gate; the
    // narrower residual risk is documented in the README's approval-hook coverage note.
  }

  let resultText: string;
  try {
    if (task.engine === 'claude') {
      const result = await claudeBridge.run(task.chatId, task.prompt);
      resultText = result.success ? result.output || '(no output)' : `Failed: ${result.error}`;
    } else {
      const provider = new AIProvider();
      const executor = new AIToolExecutor();
      const loop = new AgentLoop(provider, executor);
      const result = await loop.run(
        task.chatId,
        task.prompt,
        { chatId: task.chatId, claudeBridge },
        { sendProgress: async () => undefined, requestApproval: async () => false }
      );
      resultText = result.response;
    }
  } catch (err) {
    resultText = `Scheduled task failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  approvalServer.stop();
  markScheduledTaskRun(id);
  await bot.telegram
    .sendMessage(task.chatId, `⏰ *Scheduled: ${task.name}*\n\n${resultText}`, { parse_mode: 'Markdown' })
    .catch(() => undefined);
  process.exit(0);
}

/** `node dist/scheduled-runner.js <id>` (dev) or `AiWindowsAssistant.exe --scheduled-run <id>` (main.ts). */
export function runScheduledTask(id: number): void {
  main(id).catch((err) => {
    console.error('Fatal scheduled-runner error:', err);
    process.exit(1);
  });
}

if (require.main === module) runScheduledTask(Number(process.argv[2]));
