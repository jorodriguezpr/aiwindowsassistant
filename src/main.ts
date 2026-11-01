/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * Entry point of the packaged .exe (and dist/main.js). Handles the short-lived helper modes
 * BEFORE the app is loaded: Claude Code starts a hook process for every single tool call, so
 * those must not pay for loading the bot, the database or decrypting .env. Everything else is
 * the normal app (index.ts, which also handles its own --install-helper / --mcp-server / … flags).
 *
 *   --hook-approval / --hook-readonly   Claude Code PreToolUse hooks (src/hooks/claudeHooks.ts)
 *   --scheduled-run <id>                a /schedule task, started by Windows Task Scheduler
 */

const argv = process.argv;

if (argv.includes('--hook-approval')) {
  void require('./hooks/claudeHooks').runApprovalHook();
} else if (argv.includes('--hook-readonly')) {
  void require('./hooks/claudeHooks').runReadonlyHook();
} else if (argv.includes('--scheduled-run')) {
  const id = Number(argv[argv.indexOf('--scheduled-run') + 1]);
  require('./scheduled-runner').runScheduledTask(id);
} else {
  require('./index');
}
