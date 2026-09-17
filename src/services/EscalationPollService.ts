/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Polls SysAdminCenterHCP for Fleet Guardian "escalate to Claude Code" requests — cases its
 * own on-server AI (Ollama Cloud) can't handle because it has no repo access. This desktop is
 * the only place a real, subscription-authenticated Claude Code can run (no interactive
 * terminal exists on the VPS to complete `claude login`), so the relationship is inverted from
 * every other integration in this app: SysAdminCenterHCP can't reach this PC at all (no inbound
 * connectivity), so this service reaches out instead — poll for pending work, run it locally,
 * push the result back.
 *
 * Every escalation needs an explicit Telegram approve/deny tap before Claude Code runs — UNLESS
 * `requiresApproval` is false (currently only scheduled fleet health reports set this), reused
 * here via TelegramGateway.requestApproval, the exact same flow/5-minute-timeout
 * ApprovalHookServer already uses for gating destructive tool calls. Either way, the run itself
 * is further restricted to a read-only tool policy (scripts/claude-readonly-hook.js) — Claude
 * Code can read/search the local repo clones but cannot write, edit, or run shell commands.
 * Nothing this produces ever touches a file or a server on its own; the result is advisory text
 * that lands back in SysAdminCenterHCP (on the originating Finding, if any) for a human to read.
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { config, HOSTNAME } from '../config';
import { ClaudeCodeBridge } from '../tools/ClaudeCodeBridge';
import type { TelegramGateway } from '../gateways/TelegramGateway';
import type { Logger } from '../logger';

interface PendingEscalation {
  id: string;
  prompt: string;
  reasoning: string;
  contextRepo: string | null;
  requiresApproval: boolean;
}

const MAX_PROMPT_PREVIEW = 400;

/** TelegramGateway.requestApproval always sends with parse_mode:'Markdown' — reasoning/prompt
 * text here comes from Finding descriptions and ticket bodies (arbitrary, untrusted content)
 * and will very often contain bare _ * ` [ characters (domain names, code snippets, markdown-ish
 * user text). Telegram's legacy Markdown parser throws a 400 on any unmatched entity, which
 * silently killed the whole approval prompt. Escape before embedding — this app's own literal
 * markup around it stays intentional and unescaped. */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*`[]/g, (c) => `\\${c}`);
}

/** Deterministic-enough negative synthetic chat id, one per escalation — keeps each run's
 * Claude Code session isolated from the owner's real interactive chat and from every other
 * escalation (ClaudeCodeBridge resumes a session if chatState already has one for the id). */
/** A human-readable "what/where this is about" line, pulled from the drafted prompt's own
 * "Title:" line (Guardian and the manual-escalate modal both build prompts shaped like
 * "Category: X\nTitle: <server/finding summary>\n\n<description>") — reasoning defaults to a
 * generic "Manually escalated by an admin." for the button flow, so it's the prompt, not the
 * reasoning, that actually names the server/country/IP. Repeated in the completion message so
 * a Telegram follow-up reply has the identifying details on-screen without Claude having to ask. */
function extractSubject(escalation: PendingEscalation): string {
  const titleMatch = escalation.prompt.match(/^Title:\s*(.+)$/m);
  if (titleMatch) return titleMatch[1].trim();
  const firstLine = escalation.prompt.split('\n')[0].trim();
  return firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
}

function syntheticChatId(escalationId: string): number {
  let hash = 0;
  for (let i = 0; i < escalationId.length; i++) {
    hash = (hash * 31 + escalationId.charCodeAt(i)) | 0;
  }
  return -Math.abs(hash) - 1;
}

export class EscalationPollService {
  private http: AxiosInstance | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private hookSettingsPath: string | null = null;

  constructor(
    private claudeBridge: ClaudeCodeBridge,
    private gateway: TelegramGateway,
    private logger?: Logger
  ) {}

  start(): void {
    if (!config.escalation.baseUrl || !config.escalation.workerApiKey) {
      this.logger?.info('escalation polling not configured (SYSADMIN_CENTER_HCP_URL / ESCALATION_WORKER_API_KEY unset) — skipping');
      return;
    }
    this.http = axios.create({
      baseURL: `${config.escalation.baseUrl}/api/escalations/worker`,
      timeout: 30000,
      headers: { Authorization: `Bearer ${config.escalation.workerApiKey}` },
    });
    this.logger?.info({ interval: config.escalation.pollIntervalMs }, 'escalation polling started');
    void this.poll();
    this.timer = setInterval(() => void this.poll(), config.escalation.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.http || this.running) return;
    this.running = true;
    try {
      const { data } = await this.http.get<{ escalations: PendingEscalation[] }>('/pending?limit=3');
      for (const escalation of data.escalations || []) {
        // Sequential, not parallel — one Telegram approval prompt (and one Claude Code run) at
        // a time keeps this legible and avoids racing multiple approve/deny prompts together.
        await this.processEscalation(escalation);
      }
    } catch (err) {
      this.logger?.debug({ err }, 'escalation poll failed (will retry next interval)');
    } finally {
      this.running = false;
    }
  }

  private async processEscalation(escalation: PendingEscalation): Promise<void> {
    const [ownerId] = config.telegram.allowedUsers;
    if (!ownerId) {
      this.logger?.warn('escalation pending but TELEGRAM_ALLOWED_USERS is empty — nowhere to send the approval prompt');
      return;
    }

    try {
      await this.http!.post(`/${escalation.id}/claim`, { claimedBy: HOSTNAME });
    } catch (err) {
      this.logger?.debug({ err, id: escalation.id }, 'failed to claim escalation — likely already claimed elsewhere');
      return;
    }

    let approved = true;
    if (escalation.requiresApproval) {
      const promptPreview = escalation.prompt.length > MAX_PROMPT_PREVIEW
        ? escalation.prompt.slice(0, MAX_PROMPT_PREVIEW) + '…'
        : escalation.prompt;
      const description = `🧠 *Claude Code escalation*\n${escapeMarkdown(escalation.reasoning)}\n\n_Prompt:_\n${escapeMarkdown(promptPreview)}\n\n`
        + `Runs read-only (no file writes, no shell commands) against ${escalation.contextRepo || 'no specific repo'}.`;
      try {
        approved = await this.gateway.requestApproval(ownerId, description);
      } catch (err) {
        this.logger?.warn({ err, id: escalation.id }, 'approval request failed — treating as denied');
        approved = false;
      }
    } else {
      this.logger?.info({ id: escalation.id }, 'escalation does not require approval — running unattended');
    }

    if (!approved) {
      await this.submitResult(escalation.id, { status: 'denied' }).catch(() => undefined);
      return;
    }

    const started = Date.now();
    try {
      const result = await this.claudeBridge.run(syntheticChatId(escalation.id), escalation.prompt, {
        cwd: escalation.contextRepo ? config.escalation.repoPaths[escalation.contextRepo] : undefined,
        hookSettingsPath: this.ensureHookSettings(),
      });
      await this.submitResult(escalation.id, {
        status: result.success ? 'completed' : 'failed',
        result: result.output,
        success: result.success,
        errorMessage: result.error,
        durationMs: result.durationMs,
        sessionId: result.sessionId,
      });
      const subject = extractSubject(escalation);
      // Report-only, unattended runs (requiresApproval:false — currently just scheduled fleet
      // health reports) are meant to land in SysAdminCenterHCP's Escalations page, not ping
      // Telegram every cycle — but a FAILURE still deserves a push either way, since a silently
      // failing "standalone" health check defeats the point of having one.
      if (result.success && !escalation.requiresApproval) {
        this.logger?.info({ id: escalation.id }, 'report-only escalation completed — result posted to SysAdminCenterHCP, no Telegram ping');
      } else {
        await this.gateway.notifyOwner(
          result.success
            ? `✅ Claude Code escalation finished — ${subject}\n\n${this.tail(result.output)}`
            : `❌ Claude Code escalation failed — ${subject}: ${result.error}`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.submitResult(escalation.id, {
        status: 'failed', errorMessage: message, durationMs: Date.now() - started,
      }).catch(() => undefined);
      await this.gateway.notifyOwner(`❌ Claude Code escalation errored — ${extractSubject(escalation)}: ${message}`).catch(() => undefined);
    }
  }

  private async submitResult(id: string, body: {
    status: 'completed' | 'failed' | 'denied';
    result?: string; success?: boolean; errorMessage?: string; durationMs?: number; sessionId?: string;
  }): Promise<void> {
    await this.http!.post(`/${id}/result`, body);
  }

  private tail(text: string, max = 1200): string {
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  /** Written once into data/ (gitignored, machine-specific) — matches ClaudeCodeBridge's own
   * writeHookSettings() convention of never touching the target workspace's own settings.
   *
   * matcher is deliberately `.*` (every tool call, not a named few) — the hook script itself
   * enforces an ALLOWLIST of safe tools and denies everything else. A named-tool blocklist here
   * previously left the separate PowerShell tool (plus Cron, SendMessage, RemoteTrigger, etc.)
   * completely ungated on Windows; matching everything and allowlisting in the script is the
   * only version of this that fails closed on tools Claude Code adds in the future. */
  private ensureHookSettings(): string {
    if (this.hookSettingsPath) return this.hookSettingsPath;
    const hookScript = path.join(config.projectRoot, 'scripts', 'claude-readonly-hook.js');
    const settingsPath = path.join(config.dataDir, 'claude-escalation-readonly-settings.json');
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [{ type: 'command', command: `node "${hookScript}"`, timeout: 30 }],
          },
        ],
      },
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    this.hookSettingsPath = settingsPath;
    return settingsPath;
  }
}
