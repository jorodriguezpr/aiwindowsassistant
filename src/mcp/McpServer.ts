/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * MCP server (1.5.0): makes this app's own tools — Windows settings, screenshots, apps, admin
 * jobs, clean-up, health, UI Automation, repair routines, sysadmin, email, PDF — callable by the
 * Claude Code engine. Until 1.4 only the local-model engine could use them.
 *
 * ClaudeCodeBridge starts Claude with --mcp-config pointing here (`<app> --mcp-server`). This
 * process holds no logic and no secrets: every call is forwarded to the running app's loopback
 * ApprovalHookServer (/tool, with the per-run token), which runs it through the same gate as
 * every other tool call — policy, Telegram/notification approval, "approve 10 min" grants.
 *
 * Protocol: JSON-RPC 2.0, one message per line on stdin/stdout. stdout carries ONLY protocol
 * messages — nothing in this process may print anything else there.
 */

import * as http from 'http';
import * as readline from 'readline';
import { TOOL_DEFINITIONS } from '../tools/AITools';

/** Claude Code already has these (Read/Write/Edit/Glob/Grep/Bash/PowerShell) — or they'd recurse. */
const NOT_EXPOSED = new Set(['execute_command', 'read_file', 'write_file', 'list_directory', 'search_files', 'delete_file', 'delegate_to_claude_code']);

export const MCP_TOOL_NAMES = new Set(TOOL_DEFINITIONS.filter((t) => !NOT_EXPOSED.has(t.name)).map((t) => t.name));

export function mcpTools() {
  return TOOL_DEFINITIONS.filter((t) => !NOT_EXPOSED.has(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
}

function callApp(name: string, args: Record<string, unknown>): Promise<{ success: boolean; [k: string]: unknown }> {
  const port = Number(process.env.AIWA_APPROVAL_PORT);
  const token = process.env.AIWA_APPROVAL_TOKEN || '';
  const chatId = Number(process.env.AIWA_CHAT_ID);
  const body = JSON.stringify({ chatId, name, args });
  return new Promise((resolve) => {
    if (!port) return resolve({ success: false, error: 'AiWindowsAssistant is not reachable (no port)' });
    const req = http.request(
      { host: '127.0.0.1', port, path: '/tool', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${token}` } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve({ success: false, error: `AiWindowsAssistant refused the call (HTTP ${res.statusCode})` });
          }
        });
      }
    );
    req.on('error', (err) => resolve({ success: false, error: `AiWindowsAssistant is not reachable: ${err.message}` }));
    req.end(body);
  });
}

function resultText(r: { success: boolean; [k: string]: unknown }): string {
  const parts: string[] = [];
  for (const k of ['output', 'stdout', 'error', 'stderr']) if (r[k]) parts.push(String(r[k]));
  const rest = Object.fromEntries(Object.entries(r).filter(([k]) => !['success', 'output', 'stdout', 'error', 'stderr'].includes(k)));
  if (Object.keys(rest).length) parts.push(JSON.stringify(rest));
  return (parts.join('\n') || (r.success ? 'Done.' : 'Failed.')).slice(0, 20000);
}

export function runMcpServer(version: string): void {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params = {} } = msg;
    const reply = (result: unknown) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'aiwa', version },
          instructions:
            'Tools of AiWindowsAssistant on this Windows PC. Actions that change things ask the owner for approval ' +
            '(Telegram / a Windows notification) and may take a while; a denied or blocked call must not be retried another way.',
        });
      case 'tools/list':
        return reply({ tools: mcpTools() });
      case 'tools/call': {
        const name = String(params.name || '');
        void callApp(name, (params.arguments as Record<string, unknown>) || {}).then((r) =>
          reply({ content: [{ type: 'text', text: resultText(r) }], isError: !r.success })
        );
        return;
      }
      case 'ping':
        return reply({});
      default:
        if (id !== undefined && method && !method.startsWith('notifications/')) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  });
  rl.on('close', () => process.exit(0));
}
