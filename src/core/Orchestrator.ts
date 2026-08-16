/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import { EventEmitter } from 'events';

interface QueueEntry {
  chatId: number;
  run: () => Promise<void>;
}

/**
 * In-process replacement for AiAgentAssistant's Redis/Bull MessageBus.
 * Single-user Windows app: tasks for the same chat are serialized
 * (per-chat FIFO), different chats run concurrently (bounded).
 */
export class Orchestrator extends EventEmitter {
  private perChat = new Map<number, Promise<void>>();
  private activeCount = 0;
  private waiting: QueueEntry[] = [];
  private maxConcurrent = 3;

  /** Submit work; serialized per chat, bounded concurrency across chats. */
  submit(chatId: number, run: () => Promise<void>): Promise<void> {
    const prev = this.perChat.get(chatId) || Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.acquireAndRun(chatId, run));
    this.perChat.set(chatId, next);
    next.finally(() => {
      if (this.perChat.get(chatId) === next) this.perChat.delete(chatId);
    });
    return next;
  }

  private async acquireAndRun(chatId: number, run: () => Promise<void>): Promise<void> {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push({ chatId, run: async () => resolve() }));
    }
    this.activeCount++;
    this.emit('active', this.activeCount);
    try {
      await run();
    } finally {
      this.activeCount--;
      this.emit('active', this.activeCount);
      const next = this.waiting.shift();
      if (next) void next.run();
    }
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  getQueuedCount(): number {
    return this.waiting.length + this.perChat.size;
  }
}
