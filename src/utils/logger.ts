// ---------------------------------------------------------------------------
// Simple leveled logger with timestamps.
// No external dependency — just formatted console output.
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

function emit(level: LogLevel, context: string, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const prefix = `${timestamp()} [${LEVEL_LABELS[level]}] [${context}]`;
  if (meta !== undefined) {
    console.log(`${prefix} ${message}`, meta);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/**
 * Create a logger scoped to a named context (e.g. "cli", "ir-finder", "downloader").
 */
export function createLogger(context: string): Logger {
  return {
    debug: (msg, meta?) => emit('debug', context, msg, meta),
    info: (msg, meta?) => emit('info', context, msg, meta),
    warn: (msg, meta?) => emit('warn', context, msg, meta),
    error: (msg, meta?) => emit('error', context, msg, meta),
  };
}
