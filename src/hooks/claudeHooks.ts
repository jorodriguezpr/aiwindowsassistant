/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Claude Code PreToolUse hooks (moved here from scripts/*.js in 1.5.0 so the installed .exe can
 * run them itself — `AiWindowsAssistant.exe --hook-approval` — without Node.js on the PC; the
 * dev checkout still calls them through the thin scripts/claude-*-hook.js wrappers).
 *
 * Deliberately standalone: node built-ins only, no config/.env/database, because Claude Code
 * starts one of these for EVERY tool call — it must start fast and can't print anything else.
 *
 * approval: forwards the tool call to the running app's ApprovalHookServer, which applies the
 *   command policy and, when needed, asks the owner (Telegram / notification / chat window).
 * readonly: Fleet Guardian / BJavaDecompiler runs — an ALLOWLIST of read-only tools, everything
 *   else denied (a blocklist would have to chase every tool Claude Code adds).
 * Both fail closed: parse errors, an unreachable app, unexpected exceptions → deny.
 */

import * as http from 'http';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function deny(reason: string): never {
  console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(2);
}

export async function runApprovalHook(): Promise<void> {
  try {
    const port = process.env.AIWA_APPROVAL_PORT;
    const chatId = process.env.AIWA_CHAT_ID;
    const token = process.env.AIWA_APPROVAL_TOKEN || '';
    // not started by AiWindowsAssistant (e.g. `claude` run by hand in this workspace): stay out of the way
    if (!port || !chatId) process.exit(0);

    const raw = await readStdin();
    let input: { tool_name?: string; toolName?: string; tool_input?: unknown; toolInput?: unknown };
    try {
      input = JSON.parse(raw);
    } catch {
      return deny('approval hook could not parse tool input');
    }
    const body = JSON.stringify({ chatId: Number(chatId), toolName: input.tool_name || input.toolName || '', toolInput: input.tool_input || input.toolInput || {} });
    const decision = await new Promise<'allow' | { reason: string }>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: Number(port), path: '/approve', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${token}` } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const answer = JSON.parse(data) as { decision?: string; reason?: string };
              resolve(answer.decision === 'allow' ? 'allow' : { reason: answer.reason || 'Denied by user via Telegram' });
            } catch {
              resolve({ reason: 'approval server refused the request' }); // e.g. 401 without a body
            }
          });
        }
      );
      req.on('error', () => resolve({ reason: 'approval server unreachable' }));
      req.end(body);
    });
    if (decision === 'allow') process.exit(0);
    deny(decision.reason);
  } catch {
    deny('unexpected error in approval hook');
  }
}

const SAFE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);

export async function runReadonlyHook(): Promise<void> {
  try {
    const raw = await readStdin();
    let input: { tool_name?: string; toolName?: string };
    try {
      input = JSON.parse(raw);
    } catch {
      return deny('Read-only escalation run — could not parse tool input, denying to fail closed.');
    }
    const toolName = input.tool_name || input.toolName || '';
    if (SAFE_TOOLS.has(toolName)) process.exit(0);
    deny(`Read-only Claude Code escalation run — "${toolName}" is disabled by policy. Only ${[...SAFE_TOOLS].join('/')} are permitted.`);
  } catch {
    deny('Read-only escalation run — unexpected hook error, denying to fail closed.');
  }
}
