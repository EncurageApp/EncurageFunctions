export const TERMINAL_SETTLEMENT_MS = 30_000;

export const occurrenceKey = (
  kind: "as_needed" | "prescription",
  eventId: string,
  occurrenceAt: number
): string => `${kind}:${eventId}:${occurrenceAt}`;

export const prescriptionDoseKey = (
  eventId: string,
  occurrenceAt: number
): string => `${eventId}_${occurrenceAt}`;

export const terminalSettlementAt = (terminalDueAt: number): number =>
  terminalDueAt + TERMINAL_SETTLEMENT_MS;

export type AsNeededGivenOccurrence = {
  occurrenceAt: number;
  dose: any;
  index: number;
};

export function findNewlyGivenAsNeededOccurrence(
  beforeEvent: any,
  afterEvent: any
): AsNeededGivenOccurrence | null {
  const beforeDoses = Array.isArray(beforeEvent?.dosageGiven)
    ? beforeEvent.dosageGiven
    : [];
  const afterDoses = Array.isArray(afterEvent?.dosageGiven)
    ? afterEvent.dosageGiven
    : [];

  for (let index = 0; index < afterDoses.length; index++) {
    const beforeDose = beforeDoses[index];
    const afterDose = afterDoses[index];
    if (beforeDose?.given === true || afterDose?.given !== true) continue;

    const occurrenceAt = Number(
      beforeDose?.timeAvailable ?? beforeEvent?.nextScheduledDose
    );
    if (!Number.isFinite(occurrenceAt)) return null;
    return {occurrenceAt, dose: afterDose, index};
  }

  return null;
}

export function applyGivenPrescriptionOccurrence(
  current: any,
  occurrenceAt: number,
  givenDoseId: string,
  nextScheduledDose: number,
  resolvedAt: number
): any | undefined {
  if (current === null) return null;
  const lastResolution = current._notificationV2LastResolution;
  const isCurrentOccurrence =
    Number(current.nextScheduledDose) === occurrenceAt;
  const hasMatchingResolution =
    Number(lastResolution?.occurrenceAt) === occurrenceAt;
  if (!isCurrentOccurrence && !hasMatchingResolution) return undefined;

  return {
    ...current,
    ...(isCurrentOccurrence ? {nextScheduledDose} : {}),
    nextNotificationTime: null,
    notificationCount: null,
    snoozeInterval: null,
    _notificationV2LastResolution: {
      occurrenceAt,
      occurrenceKey: givenDoseId,
      status: "given",
      resolvedAt,
    },
    _notificationV2PendingDose: null,
  };
}

export function applyGivenAsNeededOccurrence(
  current: any,
  eventId: string,
  occurrenceAt: number,
  wasCurrentOccurrence: boolean,
  resolvedAt: number
): any | undefined {
  if (current === null) return null;
  const lastResolution = current._notificationV2LastResolution;
  const hasMatchingResolution =
    Number(lastResolution?.occurrenceAt) === occurrenceAt;
  if (!wasCurrentOccurrence && !hasMatchingResolution) return undefined;

  return {
    ...current,
    state: "active",
    nextNotificationTime: null,
    notificationCount: null,
    snoozeInterval: null,
    _notificationV2LastResolution: {
      occurrenceAt,
      occurrenceKey: occurrenceKey("as_needed", eventId, occurrenceAt),
      status: "given",
      resolvedAt,
    },
  };
}
