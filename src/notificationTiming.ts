/**
 * RTDB scheduling fields may contain null sentinels from older iOS clients.
 * Only numeric intervals may override the normal reminder cadence. Keep
 * numeric strings compatible with legacy records, without coercing objects,
 * arrays, or booleans into intervals.
 */
export function normalizeSnoozeInterval(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
}
