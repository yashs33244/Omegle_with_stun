/**
 * Structured JSON logging (pino).
 *
 * Privacy rule: never log names, photos, chat text, report details or IP
 * addresses. Log socket ids, room ids, event names and error codes only.
 */
import pino from "pino";
import type { LogLevel } from "./config";

export type Logger = pino.Logger;

export function createLogger(level: LogLevel, instanceId?: string): Logger {
  return pino({
    level,
    base: instanceId ? { instance: instanceId } : undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
