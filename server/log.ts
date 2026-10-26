/** Tiny leveled logger. LOG_LEVEL=debug|info|warn|error (default info). Per-poll lines are debug only. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const cur = (): number => LEVELS[(process.env.LOG_LEVEL as Level) in LEVELS ? (process.env.LOG_LEVEL as Level) : 'info'];
export const log = {
  debug: (...a: unknown[]) => { if (cur() <= 10) console.log(...a); },
  info: (...a: unknown[]) => { if (cur() <= 20) console.log(...a); },
  warn: (...a: unknown[]) => { if (cur() <= 30) console.warn(...a); },
  error: (...a: unknown[]) => console.error(...a),
};
export const isDebug = () => cur() <= 10;
