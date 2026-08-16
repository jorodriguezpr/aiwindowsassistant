/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { getDb } from './Database';

export type ScheduleEngine = 'claude' | 'ollama';

export interface ScheduledTaskRow {
  id: number;
  chatId: number;
  name: string;
  scheduleDesc: string;
  prompt: string;
  engine: ScheduleEngine;
  createdAt: string;
  lastRunAt: string | null;
  enabled: boolean;
}

interface RawRow {
  id: number;
  chat_id: number;
  name: string;
  schedule_desc: string;
  prompt: string;
  engine: string;
  created_at: string;
  last_run_at: string | null;
  enabled: number;
}

function rowToTask(r: RawRow): ScheduledTaskRow {
  return {
    id: r.id,
    chatId: r.chat_id,
    name: r.name,
    scheduleDesc: r.schedule_desc,
    prompt: r.prompt,
    engine: r.engine === 'ollama' ? 'ollama' : 'claude',
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
    enabled: !!r.enabled,
  };
}

/** AiWindowsAssistant's own record of what it registered in Windows Task Scheduler — the OS
 * task itself only knows *when* to fire (via SchedulerService); this table is what to actually
 * run when it does (looked up by id from scheduled-runner.ts). */
export function createScheduledTask(chatId: number, name: string, scheduleDesc: string, prompt: string, engine: ScheduleEngine): number {
  const info = getDb()
    .prepare('INSERT INTO scheduled_tasks (chat_id, name, schedule_desc, prompt, engine) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, name, scheduleDesc, prompt, engine);
  return Number(info.lastInsertRowid);
}

export function getScheduledTask(id: number): ScheduledTaskRow | undefined {
  const row = getDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as RawRow | undefined;
  return row ? rowToTask(row) : undefined;
}

export function listScheduledTasks(chatId?: number): ScheduledTaskRow[] {
  const rows = (
    chatId !== undefined
      ? getDb().prepare('SELECT * FROM scheduled_tasks WHERE chat_id = ? ORDER BY id ASC').all(chatId)
      : getDb().prepare('SELECT * FROM scheduled_tasks ORDER BY id ASC').all()
  ) as RawRow[];
  return rows.map(rowToTask);
}

export function deleteScheduledTask(id: number): void {
  getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function markScheduledTaskRun(id: number): void {
  getDb().prepare("UPDATE scheduled_tasks SET last_run_at = datetime('now') WHERE id = ?").run(id);
}
