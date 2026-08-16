/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { getDb } from './Database';

export interface NoteRow {
  id: number;
  createdAt: string;
  tags: string | null;
  summary: string;
  source: string | null;
}

function rowToNote(r: { id: number; created_at: string; tags: string | null; summary: string; source: string | null }): NoteRow {
  return { id: r.id, createdAt: r.created_at, tags: r.tags, summary: r.summary, source: r.source };
}

/** The assistant's own general-purpose knowledge base — deliberately separate from Claude
 * Code's own project-scoped MEMORY.md system (see ChatStateStore/AgentLoop for that distinction).
 * Shared by both engines; not tied to any particular project/workspace. */
export function saveNote(summary: string, tags?: string, source?: string): number {
  const info = getDb().prepare('INSERT INTO notes (tags, summary, source) VALUES (?, ?, ?)').run(tags ?? null, summary, source ?? null);
  return Number(info.lastInsertRowid);
}

export function listRecentNotes(limit = 15): NoteRow[] {
  const rows = getDb().prepare('SELECT id, created_at, tags, summary, source FROM notes ORDER BY id DESC LIMIT ?').all(limit) as Array<{
    id: number;
    created_at: string;
    tags: string | null;
    summary: string;
    source: string | null;
  }>;
  return rows.map(rowToNote);
}

export function searchNotes(query: string, limit = 20): NoteRow[] {
  const like = `%${query}%`;
  const rows = getDb()
    .prepare('SELECT id, created_at, tags, summary, source FROM notes WHERE summary LIKE ? OR tags LIKE ? ORDER BY id DESC LIMIT ?')
    .all(like, like, limit) as Array<{ id: number; created_at: string; tags: string | null; summary: string; source: string | null }>;
  return rows.map(rowToNote);
}
