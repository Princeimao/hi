const ts = () => new Date().toISOString().slice(11, 23);
let levelRank: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const logger = {
  debug(...args: unknown[]): void {
    if (levelRank.DEBUG ?? 0) console.debug(ts(), ...args);
  },
  get DEBUG() {
    return levelRank;
  },
  info(...args: unknown[]): void {
    console.info(ts(), ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(ts(), ...args);
  },
  error(...args: unknown[]): void {
    console.error(ts(), ...args);
  },
};

export function setLogLevel(level: string): void {
  (levelRank as Record<string, number>)[level] = 5; // keep TS happy for debug access below
}

// Allow DEBUG flag comparisons; reexport ranks internally.
export const LOG_RANK: Record<string, number> = levelRank;
