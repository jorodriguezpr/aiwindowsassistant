/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { getDb } from './Database';
import type { ChatMessage, ToolCall } from '../providers/AIProvider';

interface HistoryRow {
  role: ChatMessage['role'];
  content: string;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  name: string | null;
}

function rowToMessage(row: HistoryRow): ChatMessage {
  const msg: ChatMessage = { role: row.role, content: row.content };
  if (row.tool_calls_json) msg.tool_calls = JSON.parse(row.tool_calls_json) as ToolCall[];
  if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
  if (row.name) msg.name = row.name;
  return msg;
}

// ---------- conversation history ----------

export function loadHistory(chatId: number): ChatMessage[] {
  const rows = getDb()
    .prepare(
      'SELECT role, content, tool_calls_json, tool_call_id, name FROM conversation_history WHERE chat_id = ? ORDER BY seq ASC'
    )
    .all(chatId) as HistoryRow[];
  return rows.map(rowToMessage);
}

export function appendHistoryMessage(chatId: number, message: ChatMessage): void {
  const db = getDb();
  const nextSeq = (
    db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM conversation_history WHERE chat_id = ?').get(chatId) as {
      next: number;
    }
  ).next;
  db.prepare(
    'INSERT INTO conversation_history (chat_id, seq, role, content, tool_calls_json, tool_call_id, name) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    chatId,
    nextSeq,
    message.role,
    message.content,
    message.tool_calls ? JSON.stringify(message.tool_calls) : null,
    message.tool_call_id ?? null,
    message.name ?? null
  );
}

/** Wipes and rewrites a chat's full history — used after AgentLoop's summarization compresses it. */
export function replaceHistory(chatId: number, messages: ChatMessage[]): void {
  const db = getDb();
  const tx = db.transaction((msgs: ChatMessage[]) => {
    db.prepare('DELETE FROM conversation_history WHERE chat_id = ?').run(chatId);
    let seq = 1;
    const insert = db.prepare(
      'INSERT INTO conversation_history (chat_id, seq, role, content, tool_calls_json, tool_call_id, name) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const m of msgs) {
      insert.run(chatId, seq++, m.role, m.content, m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.tool_call_id ?? null, m.name ?? null);
    }
  });
  tx(messages);
}

export function clearHistory(chatId: number): void {
  getDb().prepare('DELETE FROM conversation_history WHERE chat_id = ?').run(chatId);
}

// ---------- parked (iteration-cap) state ----------

export function isParked(chatId: number): boolean {
  return !!getDb().prepare('SELECT 1 FROM parked_chats WHERE chat_id = ?').get(chatId);
}

export function setParked(chatId: number, parked: boolean): void {
  if (parked) {
    getDb().prepare('INSERT OR REPLACE INTO parked_chats (chat_id, parked_at) VALUES (?, datetime(\'now\'))').run(chatId);
  } else {
    getDb().prepare('DELETE FROM parked_chats WHERE chat_id = ?').run(chatId);
  }
}

// ---------- Claude Code sessions ----------

export function getClaudeSession(chatId: number): string | undefined {
  const row = getDb().prepare('SELECT session_id FROM claude_sessions WHERE chat_id = ?').get(chatId) as
    | { session_id: string }
    | undefined;
  return row?.session_id;
}

export function setClaudeSession(chatId: number, sessionId: string): void {
  getDb()
    .prepare(
      "INSERT INTO claude_sessions (chat_id, session_id, updated_at) VALUES (?, ?, datetime('now')) " +
        'ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at'
    )
    .run(chatId, sessionId);
}

export function clearClaudeSession(chatId: number): void {
  getDb().prepare('DELETE FROM claude_sessions WHERE chat_id = ?').run(chatId);
}

// ---------- pending-task bookkeeping (crash visibility, not true resumption) ----------

export interface PendingTaskRow {
  id: number;
  chatId: number;
  description: string;
  createdAt: string;
}

export function startPendingTask(chatId: number, description: string): number {
  const info = getDb()
    .prepare("INSERT INTO pending_tasks (chat_id, description, status) VALUES (?, ?, 'running')")
    .run(chatId, description.slice(0, 200));
  return Number(info.lastInsertRowid);
}

export function finishPendingTask(id: number, status: 'done' | 'failed'): void {
  getDb().prepare("UPDATE pending_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

export function getRunningPendingTasks(): PendingTaskRow[] {
  const rows = getDb()
    .prepare("SELECT id, chat_id, description, created_at FROM pending_tasks WHERE status = 'running' ORDER BY created_at ASC")
    .all() as Array<{ id: number; chat_id: number; description: string; created_at: string }>;
  return rows.map((r) => ({ id: r.id, chatId: r.chat_id, description: r.description, createdAt: r.created_at }));
}
