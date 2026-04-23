/**
 * logger.ts
 * Logger léger avec timestamps et niveaux de log colorés.
 * Aucune dépendance externe pour minimiser la surcharge.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Couleurs ANSI
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // Cyan
  info:  '\x1b[32m', // Vert
  warn:  '\x1b[33m', // Jaune
  error: '\x1b[31m', // Rouge
};
const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, context: string, message: string, ...args: unknown[]): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const ts    = formatTimestamp();
  const color = COLORS[level];
  const label = level.toUpperCase().padEnd(5);

  const prefix = `${DIM}${ts}${RESET} ${color}${BOLD}[${label}]${RESET} ${BOLD}[${context}]${RESET}`;

  if (args.length > 0) {
    console.log(`${prefix} ${message}`, ...args);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

/** Factory : crée un logger lié à un contexte (ex: 'SIP', 'RTP', 'ElevenLabs') */
export function createLogger(context: string) {
  return {
    debug: (message: string, ...args: unknown[]) => log('debug', context, message, ...args),
    info:  (message: string, ...args: unknown[]) => log('info',  context, message, ...args),
    warn:  (message: string, ...args: unknown[]) => log('warn',  context, message, ...args),
    error: (message: string, ...args: unknown[]) => log('error', context, message, ...args),
  };
}

export type Logger = ReturnType<typeof createLogger>;
