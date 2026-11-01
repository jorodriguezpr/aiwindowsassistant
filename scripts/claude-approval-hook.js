// AiWindowsAssistant
// Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
// GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
//
// Claude Code PreToolUse hook for a dev checkout (`node scripts/claude-approval-hook.js`).
// The logic lives in src/hooks/claudeHooks.ts (built to dist/) so the installed .exe can run the
// very same code as `AiWindowsAssistant.exe --hook-approval` without Node.js on the PC.
// Fails closed: if dist/ is missing, the tool call is denied.
try {
  require('../dist/hooks/claudeHooks').runApprovalHook();
} catch {
  console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'approval hook not built (npm run build)' } }));
  process.exit(2);
}
