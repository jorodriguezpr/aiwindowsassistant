/**
 * AiWindowsAssistant
 * Developer: Jose Rodriguez Arroyo <jrpcone@gmail.com>
 * GitHub: https://github.com/jorodriguezpr/aiwindowsassistant
 */

import pino from 'pino';
import * as path from 'path';
import * as fs from 'fs';
import { config } from './config';

const REDACT_PATHS = [
  'token',
  'apiKey',
  'api_key',
  'password',
  'authorization',
  'headers.authorization',
  'headers["x-api-key"]',
  'config.telegram.token',
  'config.ai.anthropicApiKey',
  'config.ai.ollamaCloudApiKey',
];

function dailyLogPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(config.logDir, `app-${day}.log`);
}

/**
 * Allowlist-based error serializer for pino's `err` key. Axios errors carry the
 * full request `config` (including `headers.Authorization` / `headers['x-api-key']`
 * with the raw API key) as an enumerable own property, which pino's default
 * serialization would otherwise dump verbatim into the log file on any request
 * failure. Only known-safe fields are copied out — nothing request/header shaped
 * is ever touched, so this can't be defeated by a new error field showing up later.
 */
function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  const out: Record<string, unknown> = { name: err.name, message: err.message, stack: err.stack };
  const e = err as { code?: unknown; response?: { status?: unknown; statusText?: unknown; data?: unknown } };
  if (e.code !== undefined) out.code = e.code;
  if (e.response) {
    out.responseStatus = e.response.status;
    out.responseStatusText = e.response.statusText;
  }
  return out;
}

export function createLogger(): pino.Logger {
  fs.mkdirSync(config.logDir, { recursive: true });

  const streams: pino.StreamEntry[] = [
    {
      // sync: true — async SonicBoom destinations throw "sonic boom is not ready yet"
      // if pino's process-exit hook calls flushSync before the stream has opened.
      level: config.log.level as pino.Level,
      stream: pino.destination({ dest: dailyLogPath(), mkdir: true, sync: true }),
    },
  ];

  if (process.stdout.isTTY) {
    streams.push({
      level: config.log.level as pino.Level,
      stream: pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      }),
    });
  }

  return pino(
    {
      level: config.log.level,
      redact: config.log.redactionDisabled ? { paths: [], remove: false } : { paths: REDACT_PATHS, remove: true },
      serializers: { err: serializeError },
      base: { pid: process.pid, hostname: undefined },
    },
    pino.multistream(streams)
  );
}

export type Logger = pino.Logger;
