/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Polls BJavaDecompiler for "AI Delegation" prompts (AI_PROVIDER=ai-delegation there) — its own
 * AI reconstruction/remediation pass handed off to this desktop's authenticated Claude Code CLI
 * instead of Ollama Cloud/local or OpenAI. Same inverted-connectivity shape as
 * EscalationPollService (BJavaDecompiler can't reach this PC, so this service reaches out
 * instead — poll for pending work, run it locally, push the result back), but a deliberately
 * simpler lifecycle: every prompt here is pure text reconstruction of decompiled Java source with
 * zero real-world side effects (no server access, no destructive tool calls, no Finding/server
 * context to reason about) — unlike a Guardian escalation, so there is no Telegram approve/deny
 * tap at all. Still runs Claude Code under the exact same blanket read-only hook Guardian's
 * unattended runs use (scripts/claude-readonly-hook.js) as a safety floor, since the prompt
 * content is built from AI-reconstructed decompiled bytecode — untrusted text, even though the
 * task itself is harmless.
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { config, HOSTNAME } from '../config';
import { ClaudeCodeBridge } from '../tools/ClaudeCodeBridge';
import type { TelegramGateway } from '../gateways/TelegramGateway';
import type { Logger } from '../logger';

interface PendingDelegation {
  id: string;
  prompt: string;
}

/** Deterministic-enough negative synthetic chat id, one per delegation — keeps each run's Claude
 * Code session isolated from the owner's real interactive chat and from every other delegation
 * (ClaudeCodeBridge resumes a session if chatState already has one for the id). Offset from
 * EscalationPollService's own synthetic ids (which are also negative) by forcing this range even
 * more negative, so the two queues can never collide on the same chat id by coincidence. */
function syntheticChatId(delegationId: string): number {
  let hash = 0;
  for (let i = 0; i < delegationId.length; i++) {
    hash = (hash * 31 + delegationId.charCodeAt(i)) | 0;
  }
  return -Math.abs(hash) - 1_000_000_000;
}

export class BJavaDecompilerPollService {
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
    if (!config.bjavaDecompiler.baseUrl || !config.bjavaDecompiler.workerApiKey) {
      this.logger?.info('BJavaDecompiler AI delegation polling not configured (BJAVADECOMPILER_URL / BJAVADECOMPILER_WORKER_API_KEY unset) — skipping');
      return;
    }
    this.http = axios.create({
      baseURL: `${config.bjavaDecompiler.baseUrl}/api/ai-delegation/worker`,
      timeout: 30000,
      headers: { Authorization: `Bearer ${config.bjavaDecompiler.workerApiKey}` },
    });
    this.logger?.info({ interval: config.bjavaDecompiler.pollIntervalMs }, 'BJavaDecompiler AI delegation polling started');
    void this.poll();
    this.timer = setInterval(() => void this.poll(), config.bjavaDecompiler.pollIntervalMs);
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
      const { data } = await this.http.get<{ success: boolean; data: PendingDelegation[] }>('/pending?limit=3');
      for (const delegation of data.data || []) {
        // Sequential, not parallel — one Claude Code run at a time keeps resource usage
        // predictable and avoids racing multiple headless sessions together.
        await this.processDelegation(delegation);
      }
    } catch (err) {
      this.logger?.debug({ err }, 'BJavaDecompiler delegation poll failed (will retry next interval)');
    } finally {
      this.running = false;
    }
  }

  private async processDelegation(delegation: PendingDelegation): Promise<void> {
    try {
      await this.http!.post(`/${delegation.id}/claim`, { claimedBy: HOSTNAME });
    } catch (err) {
      this.logger?.debug({ err, id: delegation.id }, 'failed to claim BJavaDecompiler delegation — likely already claimed elsewhere');
      return;
    }

    const started = Date.now();
    try {
      const result = await this.claudeBridge.run(syntheticChatId(delegation.id), delegation.prompt, {
        hookSettingsPath: this.ensureHookSettings(),
      });
      await this.submitResult(delegation.id, {
        status: result.success ? 'completed' : 'failed',
        result: result.output,
        success: result.success,
        errorMessage: result.error,
        durationMs: result.durationMs,
      });
      if (!result.success) {
        await this.gateway.notifyOwner(`❌ BJavaDecompiler AI delegation failed (${delegation.id}): ${result.error}`).catch(() => undefined);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.submitResult(delegation.id, {
        status: 'failed', errorMessage: message, durationMs: Date.now() - started,
      }).catch(() => undefined);
      await this.gateway.notifyOwner(`❌ BJavaDecompiler AI delegation errored (${delegation.id}): ${message}`).catch(() => undefined);
    }
  }

  private async submitResult(id: string, body: {
    status: 'completed' | 'failed';
    result?: string; success?: boolean; errorMessage?: string; durationMs?: number;
  }): Promise<void> {
    await this.http!.post(`/${id}/result`, body);
  }

  /** Written once into data/ (gitignored, machine-specific) — same convention as
   * EscalationPollService's own hook settings file, kept separate so the two queues' hook
   * lifecycles never interfere even though the content is currently identical. */
  private ensureHookSettings(): string {
    if (this.hookSettingsPath) return this.hookSettingsPath;
    const hookScript = path.join(config.projectRoot, 'scripts', 'claude-readonly-hook.js');
    const settingsPath = path.join(config.dataDir, 'bjavadecompiler-delegation-readonly-settings.json');
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
