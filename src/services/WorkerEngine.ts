/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Runs one delegated prompt on the chosen engine (1.6.0), for the BJavaDecompiler and Fleet
 * Guardian workers:
 *   text     (BJavaDecompiler): pure text work — reconstruct/fix code, no side effects. Claude
 *            Code with the read-only hook, or one completion from AI_PROVIDER with no tools.
 *   readonly (escalations): investigate and advise. Claude Code with the read-only hook, or this
 *            app's AgentLoop limited to READ_ONLY_TOOLS (and read-only commands), never asking.
 */

import { AIProvider } from '../providers/AIProvider';
import { AgentLoop } from '../core/AgentLoop';
import { AIToolExecutor } from '../tools/AITools';
import type { ClaudeCodeBridge } from '../tools/ClaudeCodeBridge';
import type { Engine } from './EngineSettings';
import type { Logger } from '../logger';

export interface WorkerResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  sessionId?: string;
}

/** What an investigation may use on the assistant engine: looking only. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'list_directory', 'search_files', 'get_system_info', 'execute_command',
  'get_disk_usage', 'list_processes', 'list_services', 'get_event_log_errors', 'get_network_info',
  'firewall_rule_status', 'list_scheduled_tasks', 'get_installed_software', 'get_startup_programs',
]);

const TEXT_SYSTEM =
  'You are a senior software engineer working for an automated pipeline. Do exactly what the request asks and ' +
  'return only the requested output (code, analysis or answer) — complete, no questions back, no chit-chat.';

export async function runOnEngine(
  engine: Engine,
  opts: { chatId: number; prompt: string; mode: 'text' | 'readonly'; cwd?: string; claudeBridge: ClaudeCodeBridge; hookSettingsPath: string; logger?: Logger }
): Promise<WorkerResult> {
  const started = Date.now();
  if (engine === 'claude') {
    const r = await opts.claudeBridge.run(opts.chatId, opts.prompt, { cwd: opts.cwd, hookSettingsPath: opts.hookSettingsPath });
    return { success: r.success, output: r.output, error: r.error, durationMs: r.durationMs, sessionId: r.sessionId };
  }
  try {
    const provider = new AIProvider(opts.logger);
    if (opts.mode === 'text') {
      const resp = await provider.chatCompletion([
        { role: 'system', content: TEXT_SYSTEM },
        { role: 'user', content: opts.prompt },
      ]);
      const out = (resp.content || '').trim();
      return { success: !!out, output: out, error: out ? undefined : 'empty answer from the model', durationMs: Date.now() - started };
    }
    const loop = new AgentLoop(provider, new AIToolExecutor(), opts.logger);
    const where = opts.cwd ? `\n\n(The relevant code is in ${opts.cwd}.)` : '';
    const r = await loop.run(
      opts.chatId,
      `${opts.prompt}${where}\n\nThis is a read-only investigation: look, don't change anything; end with your findings and recommendations.`,
      { chatId: opts.chatId, claudeBridge: opts.claudeBridge },
      { sendProgress: async () => undefined, requestApproval: async () => false, onlyTools: READ_ONLY_TOOLS }
    );
    loop.clear(opts.chatId);
    return { success: !r.awaitingContinuation, output: r.response, error: r.awaitingContinuation ? 'stopped at the step limit' : undefined, durationMs: Date.now() - started };
  } catch (err) {
    return { success: false, output: '', error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started };
  }
}
