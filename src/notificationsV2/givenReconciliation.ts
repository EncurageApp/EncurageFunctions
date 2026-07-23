import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {
  onValueUpdated,
  onValueWritten,
} from "firebase-functions/v2/database";
import {isNotificationV2Owner} from "./routing";
import {parentIdFromChild} from "./discovery";
import {
  applyGivenAsNeededOccurrence,
  applyGivenPrescriptionOccurrence,
  findNewlyGivenAsNeededOccurrence,
  prescriptionDoseKey,
} from "./occurrence";
import {calculateNextDoseAfterOrNull} from "./schedule";

const getDb = () => admin.app().database();

const triggerOptions = (ref: string) => ({
  ref,
  instance: "encurage-new-default-rtdb",
  region: "us-central1",
  memory: "256MiB" as const,
  timeoutSeconds: 60,
  maxInstances: 20,
});

export async function findPrescriptionOccurrenceDose(
  eventId: string,
  occurrenceAt: number
): Promise<{id: string; dose: any} | null> {
  const snapshot = await getDb()
    .ref("prescription_doses")
    .orderByChild("prescriptionEventId")
    .equalTo(eventId)
    .once("value");
  let fallback: {id: string; dose: any} | null = null;
  let given: {id: string; dose: any} | null = null;
  snapshot.forEach((doseSnapshot) => {
    const dose = doseSnapshot.val() || {};
    if (Number(dose.date) !== occurrenceAt) return false;
    const match = {id: doseSnapshot.key as string, dose};
    if (dose.given === true) {
      given = match;
      return true;
    }
    fallback = fallback || match;
    return false;
  });
  return given || fallback;
}

async function loadRoutedParentId(childId: string): Promise<string | null> {
  const childSnapshot = await getDb().ref(`children/${childId}`).once("value");
  if (!childSnapshot.exists()) return null;
  const parentId = parentIdFromChild(childSnapshot.val());
  return parentId && isNotificationV2Owner(parentId) ? parentId : null;
}

export async function cleanupSkippedPrescriptionDose(
  eventId: string,
  occurrenceAt: number,
  givenDoseId: string
): Promise<void> {
  const skippedDoseId = prescriptionDoseKey(eventId, occurrenceAt);
  if (skippedDoseId === givenDoseId) return;
  await getDb()
    .ref(`prescription_doses/${skippedDoseId}`)
    .transaction((current) => {
      if (current === null) return null;
      if (
        current.given === false &&
        current.prescriptionEventId === eventId &&
        Number(current.date) === occurrenceAt
      ) {
        return null;
      }
      return current;
    });
}

export async function reconcileGivenPrescriptionOccurrence(
  eventId: string,
  occurrenceAt: number,
  givenDoseId: string
): Promise<boolean> {
  const eventRef = getDb().ref(`prescription_events/${eventId}`);
  const eventSnapshot = await eventRef.once("value");
  if (!eventSnapshot.exists()) return false;
  const observed = eventSnapshot.val() || {};
  if (!observed.childId || !observed.prescriptionId) return false;
  const parentId = await loadRoutedParentId(String(observed.childId));
  if (!parentId) return false;

  const prescriptionSnapshot = await getDb()
    .ref(`prescription/${observed.prescriptionId}`)
    .once("value");
  if (!prescriptionSnapshot.exists()) return false;
  const prescription = prescriptionSnapshot.val();
  const nextScheduledDose = calculateNextDoseAfterOrNull(
    prescription,
    occurrenceAt,
    prescription.timeZone || "UTC"
  );
  const resolvedAt = Date.now();

  const result = await eventRef.transaction((current) => {
    return applyGivenPrescriptionOccurrence(
      current,
      occurrenceAt,
      givenDoseId,
      nextScheduledDose,
      resolvedAt
    );
  });
  if (!result.committed || !result.snapshot.exists()) return false;
  await cleanupSkippedPrescriptionDose(eventId, occurrenceAt, givenDoseId);
  return true;
}

async function reconcileGivenAsNeededOccurrence(
  eventId: string,
  beforeEvent: any,
  afterEvent: any
): Promise<boolean> {
  const given = findNewlyGivenAsNeededOccurrence(beforeEvent, afterEvent);
  if (!given || !afterEvent.childId) return false;
  const parentId = await loadRoutedParentId(String(afterEvent.childId));
  if (!parentId) return false;

  const resolvedAt = Date.now();
  const eventRef = getDb().ref(`events/${eventId}`);
  const result = await eventRef.transaction((current) => {
    const wasCurrentOccurrence =
      Number(beforeEvent.nextScheduledDose) === given.occurrenceAt;
    return applyGivenAsNeededOccurrence(
      current,
      eventId,
      given.occurrenceAt,
      wasCurrentOccurrence,
      resolvedAt
    );
  });
  return result.committed && result.snapshot.exists();
}

export const reconcilePrescriptionDoseGivenV2 = onValueWritten(
  triggerOptions("/prescription_doses/{doseId}"),
  async (event) => {
    const before = event.data.before.val() || {};
    const after = event.data.after.val() || {};
    if (before.given === true || after.given !== true) return;
    const eventId = String(after.prescriptionEventId || "");
    const occurrenceAt = Number(after.date);
    if (!eventId || !Number.isFinite(occurrenceAt)) return;

    const reconciled = await reconcileGivenPrescriptionOccurrence(
      eventId,
      occurrenceAt,
      event.params.doseId
    );
    if (reconciled) {
      logger.info("V2 reconciled prescription occurrence as given", {
        eventId,
        occurrenceAt,
      });
    }
  }
);

export const reconcileAsNeededDoseGivenV2 = onValueUpdated(
  triggerOptions("/events/{eventId}"),
  async (event) => {
    const reconciled = await reconcileGivenAsNeededOccurrence(
      event.params.eventId,
      event.data.before.val() || {},
      event.data.after.val() || {}
    );
    if (reconciled) {
      logger.info("V2 reconciled as-needed occurrence as given", {
        eventId: event.params.eventId,
      });
    }
  }
);
