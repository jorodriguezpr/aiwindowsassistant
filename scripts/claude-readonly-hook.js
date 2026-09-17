// AiWindowsAssistant
// Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
// GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
//
// Claude Code PreToolUse hook for Fleet Guardian escalation runs (EscalationPollService).
// Unlike scripts/claude-approval-hook.js (which allows non-destructive/in-workspace
// Bash/Write/Edit/NotebookEdit calls through automatically and only gates the risky ones via
// Telegram), escalations must never be able to touch a file, run a command, or cause any
// external side effect — investigate-and-advise only, no exceptions.
//
// This is deliberately an ALLOWLIST, not a blocklist, and the settings JSON that wires this in
// (EscalationPollService.ensureHookSettings) matches EVERY tool call, not just a named few.
// An earlier version matched only "Bash|Write|Edit|NotebookEdit" and left everything else
// (including the separate PowerShell tool, plus Cron*/SendMessage/RemoteTrigger/etc.)
// completely ungated — proven exploitable: denying Bash's `dir` just made Claude Code retry
// the exact same command via PowerShell, which ran unrestricted. A blocklist has to be updated
// every time Claude Code adds a tool; an allowlist fails closed on anything new by construction.
const SAFE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(2);
}

function allow() {
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return deny('Read-only escalation run — could not parse tool input, denying to fail closed.');
  }
  const toolName = input.tool_name || input.toolName || '';
  if (SAFE_TOOLS.has(toolName)) return allow();
  deny(`Read-only Claude Code escalation run — "${toolName}" is disabled by policy. Only ${[...SAFE_TOOLS].join('/')} are permitted.`);
}

main().catch(() => deny('Read-only escalation run — unexpected hook error, denying to fail closed.'));
