/**
 * core/logger — minimal leveled logger. Writes human output to stderr so stdout
 * stays clean for machine-readable payloads (hook replies, --json output).
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function currentLevel(): LogLevel {
  const env = (process.env.AGENTCONNECT_LOG ?? "info").toLowerCase();
  return (env in ORDER ? env : "info") as LogLevel;
}

function emit(level: Exclude<LogLevel, "silent">, args: unknown[]): void {
  if (ORDER[currentLevel()] < ORDER[level]) return;
  const prefix = { error: "✗", warn: "!", info: "›", debug: "·" }[level];
  // eslint-disable-next-line no-console
  console.error(prefix, ...args);
}

export const log = {
  error: (...args: unknown[]) => emit("error", args),
  warn: (...args: unknown[]) => emit("warn", args),
  info: (...args: unknown[]) => emit("info", args),
  debug: (...args: unknown[]) => emit("debug", args),
};
