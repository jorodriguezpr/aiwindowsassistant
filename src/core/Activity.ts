/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

/**
 * What the AI is doing right now (1.7.0) — and the way to stop it.
 *
 * Every piece of work registers here while it runs: your messages on either engine, /commands
 * and instant actions, photos, BJavaDecompiler delegations and Fleet Guardian escalations. Each
 * job has a label, the engine, its current step (the last tool call / progress line) and an
 * AbortController. Work waiting in the per-chat queue is listed too.
 *
 * Cancelling a job aborts its signal; whoever runs the job listens to it: the Claude Code bridge
 * kills claude.exe and every process it started, the assistant engine stops between steps and
 * kills the running command's process tree, the admin helper wait stops. /tasks shows the list,
 * /cancel stops your chat's work, /cancel all everything, /cancel <n> one job.
 */

export type JobKind = 'task' | 'worker';

export interface Job {
  id: number;
  chatId: number;
  kind: JobKind;
  engine: string;
  label: string;
  startedAt: number;
  step: string;
  stepAt: number;
  controller: AbortController;
}

export interface Queued {
  id: number;
  chatId: number;
  label: string;
  queuedAt: number;
  cancelled: boolean;
}

let nextId = 1;
const jobs = new Map<number, Job>();
const queued = new Map<number, Queued>();

export function startJob(chatId: number, kind: JobKind, engine: string, label: string): Job {
  const job: Job = { id: nextId++, chatId, kind, engine, label: oneLine(label, 90), startedAt: Date.now(), step: '', stepAt: Date.now(), controller: new AbortController() };
  jobs.set(job.id, job);
  return job;
}

export function stepJob(job: Job | undefined, step: string): void {
  if (!job) return;
  const s = oneLine(step, 120);
  if (s) {
    job.step = s;
    job.stepAt = Date.now();
  }
}

export function endJob(job: Job | undefined): void {
  if (job) jobs.delete(job.id);
}

export function addQueued(chatId: number, label: string): Queued {
  const q: Queued = { id: nextId++, chatId, label: oneLine(label, 90), queuedAt: Date.now(), cancelled: false };
  queued.set(q.id, q);
  return q;
}

export function removeQueued(q: Queued): void {
  queued.delete(q.id);
}

export const runningJobs = (): Job[] => [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
export const queuedWork = (): Queued[] => [...queued.values()].filter((q) => !q.cancelled).sort((a, b) => a.queuedAt - b.queuedAt);

/** Stop jobs and drop queued work. which: a chat id, 'all', or { id } for one item. Returns what was stopped. */
export function cancelWork(which: number | 'all' | { id: number }): { jobs: Job[]; queued: Queued[] } {
  const hit = (chatId: number, id: number) => (which === 'all' ? true : typeof which === 'number' ? chatId === which : id === which.id);
  const stoppedJobs = runningJobs().filter((j) => hit(j.chatId, j.id));
  const droppedQueued = queuedWork().filter((q) => hit(q.chatId, q.id));
  for (const q of droppedQueued) q.cancelled = true;
  for (const j of stoppedJobs) {
    j.controller.abort();
    jobs.delete(j.id);
  }
  return { jobs: stoppedJobs, queued: droppedQueued };
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function oneLine(s: string, max: number): string {
  const t = String(s || '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
