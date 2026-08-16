/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { Telegraf, Context } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { AIProvider } from '../providers/AIProvider';
import { AIToolExecutor, isDestructiveToolCall } from '../tools/AITools';
import { ClaudeCodeBridge } from '../tools/ClaudeCodeBridge';
import { AgentLoop } from '../core/AgentLoop';
import { RequestAnalyzer } from '../core/RequestAnalyzer';
import { Orchestrator } from '../core/Orchestrator';
import { getUsageSummary } from '../utils/tokenUsage';
import { isAutostartEnabled } from '../utils/autostart';
import type { Logger } from '../logger';

interface PendingApproval {
  chatId: number;
  description: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes, same as AiAgentAssistant
const TG_LIMIT = 4096;

const HELP_TEXT = `*AiWindowsAssistant* — delegate tasks from your phone 🤖

/task <text> — Delegate a task (uses the default engine — see /engine)
/claude <prompt> — Send straight to Claude Code (no history, session resumes per chat)
/execute <cmd> — Run a PowerShell command
/ai <text> — Force this one request through the local model, regardless of default engine
/engine [claude|ollama] — Show/switch the default engine for plain text and /task
/provider [anthropic|ollama-cloud|ollama] — Show/switch AI provider (used by the local-model engine)
/aimodel [model] — Show/change model
/status — Bot, provider, Claude CLI, queue status
/clear — Reset conversation + Claude Code session
/cancel — Cancel the running task
/pause, /resume — Pause/resume the bot
/help — This list

Or just type naturally — fast local actions run instantly (e.g. "open notepad", "system info"), anything else is delegated to Claude Code.`;

export class TelegramGateway {
  private bot: Telegraf;
  private provider: AIProvider;
  private executor = new AIToolExecutor();
  private loop: AgentLoop;
  private analyzer = new RequestAnalyzer();
  private claudeBridge: ClaudeCodeBridge;
  private orchestrator: Orchestrator;
  private logger?: Logger;

  private pendingApprovals = new Map<string, PendingApproval>();
  private progressMsgId = new Map<number, number>();
  private lastProgressEdit = new Map<number, number>();
  private startedAt = Date.now();
  private botUsername = '';
  /** Which engine handles plain text / /task by default — switchable via /engine. */
  private defaultEngine: 'claude' | 'ollama' = 'claude';

  paused = false;
  /** Tray menu hook — called whenever pause state changes. */
  onPauseChanged?: (paused: boolean) => void;

  constructor(claudeBridge: ClaudeCodeBridge, orchestrator: Orchestrator, logger?: Logger) {
    this.bot = new Telegraf(config.telegram.token, { handlerTimeout: 1_200_000 });
    this.provider = new AIProvider(logger);
    this.loop = new AgentLoop(this.provider, this.executor, logger);
    this.claudeBridge = claudeBridge;
    this.orchestrator = orchestrator;
    this.logger = logger;

    this.setupMiddleware();
    this.setupCommands();
    this.setupHandlers();
  }

  // ---------- setup ----------

  private isAllowed(chatId: number): boolean {
    // Fail closed: an empty/misconfigured allowlist must never mean "allow everyone".
    // /start remains reachable regardless (see setupMiddleware) so first-run setup
    // can still discover the chat ID to put in TELEGRAM_ALLOWED_USERS.
    return config.telegram.allowedUsers.includes(chatId);
  }

  private setupMiddleware(): void {
    this.bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (!this.isAllowed(chatId)) {
        // Only answer /start so the owner can discover their chat ID
        const text = (ctx.message as { text?: string } | undefined)?.text || '';
        if (text.startsWith('/start')) return next();
        await ctx.reply(`⛔ Unauthorized. Your chat ID is: ${chatId}`);
        this.logger?.warn({ chatId }, 'unauthorized access attempt');
        return;
      }
      return next();
    });
  }

  private setupCommands(): void {
    this.bot.start(async (ctx) => {
      const allowed = this.isAllowed(ctx.chat.id);
      await ctx.reply(
        `👋 *AiWindowsAssistant* online.\n\n` +
          `Your chat ID: \`${ctx.chat.id}\`${!allowed ? '\n\n⚠️ Add this ID to TELEGRAM_ALLOWED_USERS in .env and restart.' : ''}\n\n` +
          `What task would you like to delegate?`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('help', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' }));

    this.bot.command('status', async (ctx) => {
      const uptime = ((Date.now() - this.startedAt) / 60000).toFixed(0);
      const usage = getUsageSummary();
      const claudePath = this.claudeBridge.resolveCliPath();
      const apiKeyLeak = process.env.ANTHROPIC_API_KEY
        ? '\n• ⚠️ ANTHROPIC_API_KEY is set in this app\'s env — stripped before every Claude Code spawn so it always uses your subscription login, not this key.'
        : '';
      await ctx.reply(
        `📊 *Status*\n` +
          `• Bot: @${this.botUsername} ${this.paused ? '(⏸ paused)' : ''}\n` +
          `• Default engine: ${this.defaultEngine} (plain text + /task)\n` +
          `• Local model: ${this.provider.getInfo()}\n` +
          `• Claude Code CLI: ${claudePath ? '✅ ' + claudePath : '❌ not found'}\n` +
          `• Claude session (this chat): ${this.claudeBridge.hasSession(ctx.chat.id) ? 'active' : 'none'}\n` +
          `• Queue: ${this.orchestrator.getActiveCount()} active, ${this.orchestrator.getQueuedCount()} queued\n` +
          `• Uptime: ${uptime} min\n` +
          `• Tokens logged: ${usage.total.toLocaleString()} (${usage.entries} calls)\n` +
          `• Autostart: ${isAutostartEnabled() ? 'enabled' : 'disabled'}${apiKeyLeak}`,
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('task', (ctx) => this.handleDelegatedText(ctx, this.commandArgs(ctx), { skipFastPath: true }));
    this.bot.command('ai', (ctx) => this.handleDelegatedText(ctx, this.commandArgs(ctx), { skipFastPath: true, forceEngine: 'ollama' }));

    this.bot.command('engine', async (ctx) => {
      const arg = this.commandArgs(ctx).toLowerCase();
      if (!arg) return ctx.reply(`Current default engine: *${this.defaultEngine}* (used by plain text and /task)`, { parse_mode: 'Markdown' });
      if (arg !== 'claude' && arg !== 'ollama') return ctx.reply('Usage: /engine claude|ollama');
      this.defaultEngine = arg;
      await ctx.reply(`✅ Default engine set to *${this.defaultEngine}*. Plain text and /task will use it from now on.`, { parse_mode: 'Markdown' });
    });

    this.bot.command('claude', async (ctx) => {
      const prompt = this.commandArgs(ctx);
      if (!prompt) return ctx.reply('Usage: /claude <prompt for Claude Code>');
      void this.orchestrator.submit(ctx.chat.id, () => this.runClaudeTask(ctx.chat.id, prompt));
    });

    this.bot.command('execute', async (ctx) => {
      const command = this.commandArgs(ctx);
      if (!command) return ctx.reply('Usage: /execute <powershell command>');
      await this.runToolDirect(ctx.chat.id, 'execute_command', { command }, `Run: ${command}`);
    });

    this.bot.command('provider', async (ctx) => {
      const arg = this.commandArgs(ctx).toLowerCase();
      if (!arg) return ctx.reply(`Current provider: ${this.provider.getInfo()}`);
      if (!['anthropic', 'ollama-cloud', 'ollama'].includes(arg)) {
        return ctx.reply('Unknown provider. Use: anthropic | ollama-cloud | ollama');
      }
      this.provider.setProvider(arg as 'anthropic' | 'ollama-cloud' | 'ollama');
      await ctx.reply(`✅ Provider switched to ${this.provider.getInfo()}`);
    });

    this.bot.command('aimodel', async (ctx) => {
      const arg = this.commandArgs(ctx);
      if (!arg) return ctx.reply(`Current model: ${this.provider.getModel()} (provider: ${this.provider.getProvider()})`);
      this.provider.setModel(arg);
      await ctx.reply(`✅ Model set to ${arg}`);
    });

    this.bot.command('clear', async (ctx) => {
      this.loop.clear(ctx.chat.id);
      this.claudeBridge.clearSession(ctx.chat.id);
      await ctx.reply('🧹 Conversation and Claude Code session cleared. What task would you like to delegate?');
    });

    this.bot.command('cancel', async (ctx) => {
      const killed = this.claudeBridge.cancel(ctx.chat.id);
      await ctx.reply(killed ? '🛑 Claude Code task cancelled.' : 'Nothing running for this chat.');
    });

    this.bot.command('pause', async (ctx) => {
      this.setPaused(true);
      await ctx.reply('⏸ Paused. I will ignore new messages until /resume.');
    });

    this.bot.command('resume', async (ctx) => {
      this.setPaused(false);
      await ctx.reply('▶️ Resumed. What task would you like to delegate?');
    });
  }

  private setupHandlers(): void {
    this.bot.on('callback_query', async (ctx) => {
      const data = (ctx.callbackQuery as { data?: string }).data || '';
      const [action, id] = data.split(':');
      const pending = this.pendingApprovals.get(id);
      if (!pending) {
        await ctx.answerCbQuery('Expired or already handled');
        return;
      }
      this.pendingApprovals.delete(id);
      clearTimeout(pending.timer);
      const approved = action === 'appr';
      await ctx.answerCbQuery(approved ? 'Approved' : 'Denied');
      await ctx.editMessageText(
        `${pending.description}\n\n${approved ? '✅ Approved' : '❌ Denied'}`,
        { parse_mode: 'Markdown' }
      ).catch(() => undefined);
      pending.resolve(approved);
    });

    this.bot.on('text', (ctx) => this.handleDelegatedText(ctx, ctx.message.text, { skipFastPath: false }));
  }

  // ---------- message flow ----------

  private commandArgs(ctx: Context): string {
    const text = (ctx.message as { text?: string } | undefined)?.text || '';
    return text.replace(/^\/\w+(@\w+)?\s*/, '').trim();
  }

  private handleDelegatedText(
    ctx: Context,
    text: string,
    opts: { skipFastPath: boolean; forceEngine?: 'claude' | 'ollama' }
  ): Promise<unknown> | void {
    if (!text) return ctx.reply('Please provide some text.');
    const chatId = ctx.chat!.id;

    if (this.paused) {
      return ctx.reply('⏸ Bot is paused. Use /resume to continue.');
    }

    let forceEngine = opts.forceEngine;

    // continue/stop for parked loops (iteration cap), same as AiAgentAssistant
    if (this.loop.isParked(chatId)) {
      const lower = text.toLowerCase().trim();
      if (lower === 'stop') {
        this.loop.clear(chatId);
        return ctx.reply('🛑 Task stopped. What would you like to delegate next?');
      }
      if (lower === 'continue') {
        this.loop.unpark(chatId);
        forceEngine = 'ollama'; // resume the same loop that was parked, regardless of the current default
      }
    }

    void this.orchestrator.submit(chatId, async () => {
      await this.sendTyping(chatId);
      try {
        // Local fast path (RequestAnalyzer) — no AI round-trip
        if (!opts.skipFastPath) {
          const intent = this.analyzer.analyze(text);
          if (intent) {
            await this.runToolDirect(chatId, intent.tool, intent.args, intent.description);
            return;
          }
        }

        const engine = forceEngine || this.defaultEngine;
        if (engine === 'claude') {
          await this.runClaudeTask(chatId, text);
          return;
        }

        // Local AgentLoop (Ollama/Anthropic provider, tool-calling loop)
        await this.sendProgress(chatId, '🧠 Thinking…');
        const result = await this.loop.run(
          chatId,
          text,
          { chatId, claudeBridge: this.claudeBridge, onProgress: (t) => void this.sendProgressThrottled(chatId, `🤖 Claude Code:\n${this.tail(t)}`) },
          {
            sendProgress: (t) => this.sendProgressThrottled(chatId, t),
            requestApproval: (desc) => this.requestApproval(chatId, desc),
            onToolProgress: (t) => void this.sendProgressThrottled(chatId, `🤖 Claude Code:\n${this.tail(t)}`),
          }
        );
        await this.clearProgress(chatId);
        await this.sendLong(chatId, result.response);
      } catch (err) {
        await this.clearProgress(chatId);
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.error({ err }, 'task failed');
        await this.sendLong(chatId, `❌ Error: ${msg}`);
      }
    });
  }

  /** Direct single-tool execution (used by /execute and the local fast path). */
  private async runToolDirect(chatId: number, tool: string, args: Record<string, unknown>, description: string): Promise<void> {
    if (isDestructiveToolCall(tool, args)) {
      const approved = await this.requestApproval(chatId, `⚠️ *Destructive action*\n${description}`);
      if (!approved) {
        await this.bot.telegram.sendMessage(chatId, '❌ Denied.');
        return;
      }
    }
    await this.sendTyping(chatId);
    const result = await this.executor.execute(tool, JSON.stringify(args), {
      chatId,
      claudeBridge: this.claudeBridge,
      requestApproval: (d) => this.requestApproval(chatId, d),
      onProgress: (t) => void this.sendProgressThrottled(chatId, `🤖 Claude Code:\n${this.tail(t)}`),
    });
    const out = result.success
      ? `✅ ${description}\n${String(result.output ?? result.stdout ?? 'Done.')}`
      : `❌ ${description}\n${result.error || 'Failed'}${result.stderr ? '\n' + result.stderr : ''}`;
    await this.sendLong(chatId, out);
    await this.bot.telegram.sendMessage(chatId, 'What task would you like to delegate next?');
  }

  /**
   * Runs a prompt through Claude Code. Caller is responsible for orchestrator.submit()
   * — this must NOT submit itself, since handleDelegatedText's default engine path calls
   * this from inside an already-submitted callback (submitting again for the same chatId
   * from within that callback would deadlock: the outer task would wait on the inner one,
   * which waits on the outer one finishing first).
   */
  private async runClaudeTask(chatId: number, prompt: string): Promise<void> {
    await this.sendTyping(chatId);
    await this.sendProgress(chatId, '🤖 Claude Code is working…');
    const result = await this.claudeBridge.run(chatId, prompt, {
      onProgress: (t) => void this.sendProgressThrottled(chatId, `🤖 Claude Code:\n${this.tail(t)}`),
    });
    await this.clearProgress(chatId);
    if (result.success) {
      await this.sendLong(chatId, result.output || '✅ Done (no output).');
    } else {
      await this.sendLong(chatId, `❌ Claude Code failed: ${result.error}${result.output ? '\n\n' + result.output : ''}`);
    }
    await this.bot.telegram.sendMessage(chatId, 'Anything else to delegate?');
  }

  // ---------- approvals ----------

  /** Public: also used by ApprovalHookServer to gate Claude Code's own tool calls. */
  requestApproval = (chatId: number, description: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const id = uuidv4().slice(0, 8);
      const timer = setTimeout(() => {
        if (this.pendingApprovals.delete(id)) {
          this.bot.telegram.sendMessage(chatId, '⏱ Approval expired — action cancelled.').catch(() => undefined);
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(id, { chatId, description, resolve, timer });
      this.bot.telegram
        .sendMessage(chatId, `⚠️ *Approval required*\n${description}`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `appr:${id}` },
                { text: '❌ Deny', callback_data: `deny:${id}` },
              ],
            ],
          },
        })
        .catch((err) => {
          this.logger?.error({ err }, 'failed to send approval request');
          clearTimeout(timer);
          this.pendingApprovals.delete(id);
          resolve(false);
        });
    });
  };

  // ---------- telegram helpers ----------

  private async sendTyping(chatId: number): Promise<void> {
    await this.bot.telegram.sendChatAction(chatId, 'typing').catch(() => undefined);
  }

  private async sendProgress(chatId: number, text: string): Promise<void> {
    try {
      const existing = this.progressMsgId.get(chatId);
      if (existing) {
        await this.bot.telegram.editMessageText(chatId, existing, undefined, this.tail(text));
      } else {
        const msg = await this.bot.telegram.sendMessage(chatId, this.tail(text));
        this.progressMsgId.set(chatId, msg.message_id);
      }
      this.lastProgressEdit.set(chatId, Date.now());
    } catch {
      /* edit races are harmless */
    }
  }

  /** Throttled progress edit (Telegram rate-limits edits). */
  private async sendProgressThrottled(chatId: number, text: string): Promise<void> {
    const last = this.lastProgressEdit.get(chatId) || 0;
    if (Date.now() - last < 1500) return;
    await this.sendProgress(chatId, text);
  }

  private async clearProgress(chatId: number): Promise<void> {
    const id = this.progressMsgId.get(chatId);
    this.progressMsgId.delete(chatId);
    if (id) await this.bot.telegram.deleteMessage(chatId, id).catch(() => undefined);
  }

  private tail(text: string, max = 500): string {
    return text.length > max ? '…' + text.slice(-max) : text;
  }

  /** Split at Telegram's 4096-char limit (same as AiAgentAssistant). */
  private async sendLong(chatId: number, text: string): Promise<void> {
    if (!text) text = '(no output)';
    for (let i = 0; i < text.length; i += TG_LIMIT) {
      const chunk = text.slice(i, i + TG_LIMIT);
      try {
        await this.bot.telegram.sendMessage(chatId, chunk);
      } catch {
        await this.bot.telegram.sendMessage(chatId, chunk.replace(/[*_`[\]]/g, '')).catch(() => undefined);
      }
    }
  }

  // ---------- lifecycle ----------

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.onPauseChanged?.(paused);
  }

  async launch(): Promise<void> {
    await this.bot.telegram.setMyCommands([
      { command: 'task', description: 'Delegate a task' },
      { command: 'claude', description: 'Send prompt to Claude Code' },
      { command: 'execute', description: 'Run a PowerShell command' },
      { command: 'ai', description: 'Force full AI loop' },
      { command: 'provider', description: 'Show/switch AI provider' },
      { command: 'aimodel', description: 'Show/change model' },
      { command: 'status', description: 'Bot status' },
      { command: 'clear', description: 'Reset conversation' },
      { command: 'cancel', description: 'Cancel running task' },
      { command: 'pause', description: 'Pause bot' },
      { command: 'resume', description: 'Resume bot' },
      { command: 'help', description: 'Help' },
    ]);
    // Long polling, same as AiAgentAssistant
    void this.bot.launch({ dropPendingUpdates: true });
    const me = await this.bot.telegram.getMe();
    this.botUsername = me.username || '';
    this.logger?.info({ username: this.botUsername }, 'telegram bot launched');
  }

  async notifyOwner(text: string): Promise<void> {
    const [owner] = config.telegram.allowedUsers;
    if (owner) await this.bot.telegram.sendMessage(owner, text).catch(() => undefined);
  }

  stop(reason: string): void {
    this.bot.stop(reason);
  }
}
