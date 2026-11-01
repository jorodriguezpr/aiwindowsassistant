/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * The one gate every tool call goes through (1.5.0): the local AI loop, /commands and instant
 * shortcuts, Claude Code's MCP tool calls, repair routines. Policy first (allow / ask / deny —
 * AITools.toolCallDecision), then the owner's answer.
 *
 * "Approve for 10 min": some actions come in bursts — clicking through one app's dialogs with UI
 * Automation is many small steps. Their decision carries a grantKey (e.g. the window title); the
 * owner can approve that key for 10 minutes instead of tapping Approve for every click. Only for
 * decisions that offer a grantKey, never for blocked ones, per chat, in memory (gone on restart).
 */

import { toolCallDecision } from '../tools/AITools';

const grants = new Map<string, number>(); // `${chatId}|${key}` -> expiry (ms)

export function grant(chatId: number, key: string, minutes: number): void {
  grants.set(`${chatId}|${key}`, Date.now() + minutes * 60_000);
}

export function hasGrant(chatId: number, key: string): boolean {
  const until = grants.get(`${chatId}|${key}`);
  if (!until) return false;
  if (until < Date.now()) {
    grants.delete(`${chatId}|${key}`);
    return false;
  }
  return true;
}

/** Ask the owner; `grantKey` set = the prompt may offer "Approve for 10 min". */
export type Approver = (description: string, grantKey?: string) => Promise<boolean>;

export interface GateResult {
  ok: boolean;
  /** for the AI / the user when not ok */
  error?: string;
  blocked?: boolean;
}

export async function gateToolCall(chatId: number, name: string, args: Record<string, unknown>, description: string, approve: Approver): Promise<GateResult> {
  const d = toolCallDecision(name, args);
  if (d.verdict === 'deny') return { ok: false, blocked: true, error: `Blocked by security policy: ${d.reason}. Do not retry this another way.` };
  if (d.verdict === 'ask') {
    if (d.grantKey && hasGrant(chatId, d.grantKey)) return { ok: true };
    const approved = await approve(`${description}\n_Why approval: ${d.reason}_`, d.grantKey);
    if (!approved) return { ok: false, error: 'Denied by user' };
  }
  return { ok: true };
}
