// AiWindowsAssistant
// Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
// GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
//
// Claude Code PreToolUse hook for read-only escalation runs, dev checkout version
// (`node scripts/claude-readonly-hook.js`). Logic: src/hooks/claudeHooks.ts — the installed .exe
// runs the same code as `AiWindowsAssistant.exe --hook-readonly`. Fails closed if dist/ is missing.
try {
  require('../dist/hooks/claudeHooks').runReadonlyHook();
} catch {
  console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'read-only hook not built (npm run build)' } }));
  process.exit(2);
}
