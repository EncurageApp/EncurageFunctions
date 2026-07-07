import {MINUTE_MS} from "./schedule";

export type WorkerKind = "initial" | "reminder";

export const LIVE_DISCOVERY_LOOKBACK_MS = 5 * MINUTE_MS;

export const dueFieldForWorker = (
  workerKind: WorkerKind
): "nextScheduledDose" | "nextNotificationTime" =>
  workerKind === "initial" ? "nextScheduledDose" : "nextNotificationTime";

export const parentIdFromEvent = (event: any): string | null =>
  typeof event?.parentId === "string" && event.parentId
    ? event.parentId
    : null;

export const parentIdFromChild = (child: any): string | null => {
  const parentId = child?.parentId || child?.parent_id;
  return typeof parentId === "string" && parentId ? parentId : null;
};

export const shouldRepairParentId = (
  storedParentId: string | null,
  actualParentId: string,
  isCanary: (parentId: string) => boolean
): boolean =>
  storedParentId !== actualParentId &&
  (isCanary(actualParentId) ||
    (storedParentId !== null && isCanary(storedParentId)));

export const hasReminderState = (event: any): boolean =>
  Number.isFinite(Number(event?.nextNotificationTime)) &&
  Number(event?.notificationCount) >= 1 &&
  Number(event?.notificationCount) <= 4;

export const dueAtForWorker = (
  event: any,
  workerKind: WorkerKind
): number => {
  const value = event?.[dueFieldForWorker(workerKind)];
  return value == null ? Number.NaN : Number(value);
};

export const isWorkerCandidate = (
  event: any,
  workerKind: WorkerKind,
  rangeStart: number,
  rangeEnd: number
): boolean => {
  if (event?.state !== "active") return false;

  const isReminder = hasReminderState(event);
  if (
    (workerKind === "reminder" && !isReminder) ||
    (workerKind === "initial" && isReminder)
  ) {
    return false;
  }

  const dueAt = dueAtForWorker(event, workerKind);
  return Number.isFinite(dueAt) && dueAt >= rangeStart && dueAt <= rangeEnd;
};
