// AiWindowsAssistant
// Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
// GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
//
// Claude Code PreToolUse hook. Reads the tool call Claude Code is about to make
// from stdin, forwards it to AiWindowsAssistant's local ApprovalHookServer, and
// blocks until the user approves/denies via Telegram (or the request server-side
// decides it isn't destructive and auto-allows it).
//
// Fails closed at every step: if this app isn't the one running claude (no
// AIWA_* env vars — e.g. you ran `claude` by hand in this workspace), it gets
// out of the way immediately. Otherwise, any parse error, unreachable server,
// or unexpected exception denies the tool call rather than silently allowing it.
const http = require('http');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function deny(reason) {
  console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(2);
}

async function main() {
  const port = process.env.AIWA_APPROVAL_PORT;
  const chatId = process.env.AIWA_CHAT_ID;
  if (!port || !chatId) {
    process.exit(0); // not a AiWindowsAssistant-spawned run — don't interfere
  }

  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return deny('approval hook could not parse tool input');
  }

  const toolName = input.tool_name || input.toolName || '';
  const toolInput = input.tool_input || input.toolInput || {};
  const body = JSON.stringify({ chatId: Number(chatId), toolName, toolInput });

  const decision = await new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(port),
        path: '/approve',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).decision === 'allow' ? 'allow' : 'deny');
          } catch {
            resolve('deny');
          }
        });
      }
    );
    req.on('error', () => resolve('deny')); // approval server unreachable — fail closed
    req.write(body);
    req.end();
  });

  if (decision === 'allow') process.exit(0);
  deny('Denied by user via Telegram');
}

main().catch(() => deny('unexpected error in approval hook'));
