import * as admin from "firebase-admin";
import {getFunctions} from "firebase-admin/functions";
import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {onTaskDispatched} from "firebase-functions/v2/tasks";
import {createHash, randomUUID} from "crypto";
import {notificationV2CanaryUids} from "./config";
import {
  getNotificationV2Route,
  isNotificationV2Owner,
  NotificationV2RouteReason,
  notificationV2RoutingEnabled,
  notificationV2UsesStaticCanaryOnly,
} from "./routing";
import {
  calculateNextDoseAfter,
  DueStage,
  resolveDueStage,
  TERMINAL_SEND_GRACE_MS,
} from "./schedule";
import {
  dueAtForWorker,
  dueFieldForWorker,
  hasReminderState,
  isWorkerCandidate,
  LIVE_DISCOVERY_LOOKBACK_MS,
  parentIdFromChild,
  parentIdFromEvent,
  shouldRepairParentId,
  WorkerKind,
} from "./discovery";
import {
  cleanupSkippedPrescriptionDose,
  findPrescriptionOccurrenceDose,
  reconcileGivenPrescriptionOccurrence,
} from "./givenReconciliation";
import {
  prescriptionDoseKey,
  terminalSettlementAt,
} from "./occurrence";

const BATCH_SIZE = 500;
const EVENT_CONCURRENCY = 25;
const LEASE_MS = 6 * 60_000;
const MAX_RECONCILIATION_HOPS = 20;
const MAX_RECOVERY_SCAN_PAGES = 20;

type EventCollection = "events" | "prescription_events";
type EventKind = "as_needed" | "prescription";

type RoutedEvent = {
  eventId: string;
  event: any;
  child: any;
  ownerUid: string;
  routeReason: NotificationV2RouteReason;
  routeBucket?: number;
};

type Recipient = {
  uid: string;
  user: any;
};

type LiveDiscoveryResult = {
  candidates: RoutedEvent[];
  pageCount: number;
  scannedCount: number;
};

type StaleDiscoveryResult = {
  initial: RoutedEvent[];
  reminder: RoutedEvent[];
};

type TerminalSettlementTask = {
  kind: EventKind;
  eventId: string;
  childId: string;
  occurrenceAt: number;
  dueAt: number;
};

const getDb = () => admin.app().database();

const getEventKind = (collection: EventCollection): EventKind =>
  collection === "events" ? "as_needed" : "prescription";

const checkpointKey = (
  kind: EventKind,
  eventId: string,
  occurrenceAt: number,
  stage: number
) => `${kind}:${eventId}:${occurrenceAt}:${stage}`;

const safeKey = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

async function loadUser(uid: string): Promise<any | null> {
  const snapshot = await getDb().ref(`users/${uid}`).once("value");
  return snapshot.exists() ? {...snapshot.val(), uid} : null;
}

async function loadCanaryChildren(): Promise<Map<string, any>> {
  const children = new Map<string, any>();
  const db = getDb();

  for (const ownerUid of notificationV2CanaryUids) {
    for (const ownerField of ["parentId", "parent_id"]) {
      const snapshot = await db
        .ref("children")
        .orderByChild(ownerField)
        .equalTo(ownerUid)
        .once("value");
      snapshot.forEach((childSnapshot) => {
        const child = childSnapshot.val() || {};
        const resolvedOwner = child.parentId || child.parent_id;
        const route = getNotificationV2Route(resolvedOwner);
        if (route.useV2) {
          children.set(childSnapshot.key as string, {
            ...child,
            childId: child.childId || childSnapshot.key,
            ownerUid: resolvedOwner,
            routeReason: route.reason,
            routeBucket: route.bucket,
          });
        }
      });
    }
  }

  return children;
}

async function loadChild(childId: string): Promise<any | null> {
  const snapshot = await getDb().ref(`children/${childId}`).once("value");
  if (!snapshot.exists()) return null;
  const child = snapshot.val() || {};
  return {
    ...child,
    childId: child.childId || childId,
    ownerUid: parentIdFromChild(child),
  };
}

async function repairEventParentId(
  collection: EventCollection,
  eventId: string,
  storedParentId: string | null,
  actualParentId: string
): Promise<void> {
  if (storedParentId === actualParentId) return;
  await getDb().ref(`${collection}/${eventId}/parentId`).set(actualParentId);
  logger.info("V2 repaired event parentId", {collection, eventId});
}

async function resolveLiveCanaryCandidates(
  collection: EventCollection,
  entries: Array<{eventId: string; event: any}>,
  childCache: Map<string, Promise<any | null>>
): Promise<RoutedEvent[]> {
  const {default: pLimit} = await import("p-limit");
  const limit = pLimit(EVENT_CONCURRENCY);
  const resolved = await Promise.all(
    entries.map(({eventId, event}) =>
      limit(async () => {
        const storedParentId = parentIdFromEvent(event);
        const storedRoute = getNotificationV2Route(storedParentId || undefined);
        if (storedParentId && !storedRoute.useV2) {
          return null;
        }

        const childId = String(event.childId || "");
        if (!childId) {
          logger.warn("V2 due event has no childId", {eventId});
          return null;
        }

        let childPromise = childCache.get(childId);
        if (!childPromise) {
          childPromise = loadChild(childId);
          childCache.set(childId, childPromise);
        }
        const child = await childPromise;
        if (!child) {
          logger.warn("V2 child not found for due event", {eventId, childId});
          return null;
        }

        const actualParentId = parentIdFromChild(child);
        if (!actualParentId) {
          logger.warn("V2 child has no parentId", {eventId, childId});
          return null;
        }
        const actualRoute = getNotificationV2Route(actualParentId);
        if (
          shouldRepairParentId(
            storedParentId,
            actualParentId,
            isNotificationV2Owner
          )
        ) {
          await repairEventParentId(
            collection,
            eventId,
            storedParentId,
            actualParentId
          );
        }
        if (!actualRoute.useV2) return null;
        return {
          eventId,
          event: {...event, parentId: actualParentId},
          child,
          ownerUid: actualParentId,
          routeReason: actualRoute.reason,
          routeBucket: actualRoute.bucket,
        } as RoutedEvent;
      })
    )
  );
  return resolved.filter((candidate): candidate is RoutedEvent => !!candidate);
}

async function loadLiveCanaryEvents(
  collection: EventCollection,
  workerKind: WorkerKind,
  rangeStart: number,
  rangeEnd: number
): Promise<LiveDiscoveryResult> {
  const events = new Map<string, RoutedEvent>();
  const childCache = new Map<string, Promise<any | null>>();
  const dueField = dueFieldForWorker(workerKind);
  let cursor: {dueAt: number; eventId: string} | null = null;
  let pageCount = 0;
  let scannedCount = 0;

  while (true) {
    const pageLimit = cursor ? BATCH_SIZE + 1 : BATCH_SIZE;
    let query = getDb()
      .ref(collection)
      .orderByChild(dueField)
      .startAt(cursor?.dueAt ?? rangeStart, cursor?.eventId)
      .endAt(rangeEnd)
      .limitToFirst(pageLimit);
    const snapshot = await query.once("value");
    const page: Array<{eventId: string; event: any; dueAt: number}> = [];
    snapshot.forEach((eventSnapshot) => {
      const event = eventSnapshot.val() || {};
      page.push({
        eventId: eventSnapshot.key as string,
        event,
        dueAt: dueAtForWorker(event, workerKind),
      });
    });
    pageCount++;

    const newEntries = cursor
      ? page.filter(
          ({eventId, dueAt}) =>
            eventId !== cursor?.eventId || dueAt !== cursor.dueAt
        )
      : page;
    scannedCount += newEntries.length;

    const matchingEntries = newEntries.filter(({event}) =>
      isWorkerCandidate(event, workerKind, rangeStart, rangeEnd)
    );
    const candidates = await resolveLiveCanaryCandidates(
      collection,
      matchingEntries,
      childCache
    );
    candidates.forEach((candidate) => events.set(candidate.eventId, candidate));

    if (page.length < pageLimit) break;
    const last = page[page.length - 1];
    if (
      !last ||
      (cursor && last.eventId === cursor.eventId && last.dueAt === cursor.dueAt)
    ) {
      logger.error("V2 live discovery pagination made no progress", {
        collection,
        workerKind,
        cursor,
      });
      break;
    }
    cursor = {dueAt: last.dueAt, eventId: last.eventId};
  }

  return {
    candidates: [...events.values()].sort(
      (left, right) =>
        dueAtForWorker(left.event, workerKind) -
        dueAtForWorker(right.event, workerKind)
    ),
    pageCount,
    scannedCount,
  };
}

async function loadStaleCanaryEvents(
  collection: EventCollection,
  before: number
): Promise<StaleDiscoveryResult> {
  const children = await loadCanaryChildren();
  const initial = new Map<string, RoutedEvent>();
  const reminder = new Map<string, RoutedEvent>();
  const db = getDb();

  for (const child of children.values()) {
    const snapshot = await db
      .ref(collection)
      .orderByChild("childId")
      .equalTo(child.childId)
      .once("value");

    snapshot.forEach((eventSnapshot) => {
      const event = eventSnapshot.val() || {};
      const workerKind: WorkerKind = hasReminderState(event)
        ? "reminder"
        : "initial";
      if (isWorkerCandidate(
        event,
        workerKind,
        Number.MIN_SAFE_INTEGER,
        before - 1
      )) {
        const candidate = {
          eventId: eventSnapshot.key as string,
          event,
          child,
          ownerUid: child.ownerUid,
          routeReason: child.routeReason,
          routeBucket: child.routeBucket,
        };
        (workerKind === "reminder" ? reminder : initial).set(
          candidate.eventId,
          candidate
        );
      }
    });
  }

  const sortByDueAt = (workerKind: WorkerKind) =>
    (left: RoutedEvent, right: RoutedEvent) =>
      dueAtForWorker(left.event, workerKind) -
      dueAtForWorker(right.event, workerKind);

  return {
    initial: [...initial.values()].sort(sortByDueAt("initial")),
    reminder: [...reminder.values()].sort(sortByDueAt("reminder")),
  };
}

async function loadStaleDueEvents(
  collection: EventCollection,
  workerKind: WorkerKind,
  before: number
): Promise<LiveDiscoveryResult> {
  const events = new Map<string, RoutedEvent>();
  const childCache = new Map<string, Promise<any | null>>();
  const dueField = dueFieldForWorker(workerKind);
  let cursor: {dueAt: number; eventId: string} | null = null;
  let pageCount = 0;
  let scannedCount = 0;

  while (pageCount < MAX_RECOVERY_SCAN_PAGES && events.size < BATCH_SIZE) {
    const pageLimit = cursor ? BATCH_SIZE + 1 : BATCH_SIZE;
    const snapshot = await getDb()
      .ref(collection)
      .orderByChild(dueField)
      .startAt(cursor?.dueAt ?? Number.MIN_SAFE_INTEGER, cursor?.eventId)
      .endAt(before)
      .limitToFirst(pageLimit)
      .once("value");
    const page: Array<{eventId: string; event: any; dueAt: number}> = [];
    snapshot.forEach((eventSnapshot) => {
      const event = eventSnapshot.val() || {};
      page.push({
        eventId: eventSnapshot.key as string,
        event,
        dueAt: dueAtForWorker(event, workerKind),
      });
    });
    pageCount++;

    const newEntries = cursor
      ? page.filter(
          ({eventId, dueAt}) =>
            eventId !== cursor?.eventId || dueAt !== cursor.dueAt
        )
      : page;
    scannedCount += newEntries.length;

    const matchingEntries = newEntries.filter(({event}) =>
      isWorkerCandidate(
        event,
        workerKind,
        Number.MIN_SAFE_INTEGER,
        before
      )
    );
    const candidates = await resolveLiveCanaryCandidates(
      collection,
      matchingEntries,
      childCache
    );
    candidates.forEach((candidate) => events.set(candidate.eventId, candidate));

    if (page.length < pageLimit) break;
    const last = page[page.length - 1];
    if (
      !last ||
      (cursor && last.eventId === cursor.eventId && last.dueAt === cursor.dueAt)
    ) {
      logger.error("V2 stale discovery pagination made no progress", {
        collection,
        workerKind,
        cursor,
      });
      break;
    }
    cursor = {dueAt: last.dueAt, eventId: last.eventId};
  }

  return {
    candidates: [...events.values()].sort(
      (left, right) =>
        dueAtForWorker(left.event, workerKind) -
        dueAtForWorker(right.event, workerKind)
    ),
    pageCount,
    scannedCount,
  };
}

async function loadStaleRoutedEvents(
  collection: EventCollection,
  before: number
): Promise<StaleDiscoveryResult> {
  if (notificationV2UsesStaticCanaryOnly) {
    return loadStaleCanaryEvents(collection, before);
  }
  const [initial, reminder] = await Promise.all([
    loadStaleDueEvents(collection, "initial", before),
    loadStaleDueEvents(collection, "reminder", before),
  ]);
  logger.info("Notification V2 indexed recovery discovery completed", {
    collection,
    initialScannedCount: initial.scannedCount,
    initialPageCount: initial.pageCount,
    reminderScannedCount: reminder.scannedCount,
    reminderPageCount: reminder.pageCount,
  });
  return {initial: initial.candidates, reminder: reminder.candidates};
}

async function runBatches<T>(
  values: T[],
  operation: (value: T) => Promise<void>
): Promise<void> {
  const {default: pLimit} = await import("p-limit");
  const limit = pLimit(EVENT_CONCURRENCY);

  for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
    const batch = values.slice(offset, offset + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((value) => limit(() => operation(value)))
    );
    results.forEach((result) => {
      if (result.status === "rejected") {
        logger.error("Notification V2 event processing failed", result.reason);
      }
    });
  }
}

async function acquireLease(
  kind: EventKind,
  eventId: string,
  executionId: string,
  now: number
): Promise<boolean> {
  const leaseRef = getDb().ref(`notification_v2_runtime/${kind}/${eventId}/lease`);
  const result = await leaseRef.transaction((current) => {
    if (
      current &&
      Number(current.until) > now &&
      current.owner !== executionId
    ) {
      return current;
    }
    return {owner: executionId, until: now + LEASE_MS, claimedAt: now};
  });
  return result.committed && result.snapshot.val()?.owner === executionId;
}

async function releaseLease(
  kind: EventKind,
  eventId: string,
  executionId: string
): Promise<void> {
  const leaseRef = getDb().ref(`notification_v2_runtime/${kind}/${eventId}/lease`);
  await leaseRef.transaction((current) => {
    if (current?.owner === executionId) return null;
    return current;
  });
}

function getLanguage(user?: any): "en" | "es" {
  return String(user?.pnLanguage || "en").toLowerCase() === "es" ? "es" : "en";
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function translateCycle(cycle: string, language: "en" | "es"): string {
  const translations: Record<string, {en: string; es: string}> = {
    acetaminophen: {en: "Acetaminophen", es: "Paracetamol"},
    ibuprofen: {en: "Ibuprofen", es: "Ibuprofeno"},
    alternating: {en: "Alternating", es: "Alternar"},
  };
  const match = translations[String(cycle || "").toLowerCase()];
  return match?.[language] || cycle || "";
}

function asNeededMessage(
  childName: string,
  cycleName: string,
  stage: number,
  language: "en" | "es"
): string {
  const cycle = translateCycle(cycleName, language);
  if (language === "es") {
    switch (stage) {
      case 0:
        return `${childName} puede recibir la siguiente dosis de ${cycle} ahora. Pulsa aquí para administrar la dosis.`;
      case 1:
        return `Recordatorio 2: la dosis de ${cycle} de ${childName} está disponible.`;
      case 2:
        return `Recordatorio 3: la dosis de ${cycle} de ${childName} está disponible.`;
      case 3:
        return `Recordatorio 4: la dosis de ${cycle} de ${childName} está disponible.`;
      default:
        return `El episodio de ${cycle} de ${childName} está en pausa. Pulsa para continuar.`;
    }
  }
  switch (stage) {
    case 0:
      return `${childName} can get the next ${cycle} dose now. Tap to give the dose.`;
    case 1:
      return `2nd reminder: ${childName}'s ${cycle} dose is available.`;
    case 2:
      return `3rd reminder: ${childName}'s ${cycle} dose is available.`;
    case 3:
      return `4th reminder: ${childName}'s ${cycle} dose is available.`;
    default:
      return `${childName}'s ${cycle} episode is now paused. Tap to resume.`;
  }
}

function prescriptionMessage(
  childName: string,
  medicationName: string,
  stage: number,
  language: "en" | "es"
): string {
  const medication = capitalize(medicationName);
  if (language === "es") {
    if (stage === 0) {
      return `Es tiempo de la siguiente dosis de ${medication} para ${childName}. Pulsa para administrar la dosis.`;
    }
    if (stage === 4) {
      return `Se omitió la dosis de ${medication} para ${childName}. Ingresa al programa para ver o editar.`;
    }
    return `La dosis de ${medication} para ${childName} está pendiente. Pulsa para dar la dosis.`;
  }
  if (stage === 0) {
    return `It's time for ${childName}'s next dose of ${medication}. Tap to give the dose.`;
  }
  if (stage === 4) {
    return `${childName}'s ${medication} dose was skipped. Head to the schedule to view or edit.`;
  }
  return `${childName}'s ${medication} dose is due. Tap to give the dose.`;
}

async function loadRecipients(ownerUid: string, childId: string): Promise<Recipient[]> {
  const db = getDb();
  const recipients = new Map<string, Recipient>();
  const owner = await loadUser(ownerUid);
  if (owner) recipients.set(ownerUid, {uid: ownerUid, user: owner});

  const caregivers = await db
    .ref("caregiver")
    .orderByChild("parent_id")
    .equalTo(ownerUid)
    .once("value");
  const caregiverUids: string[] = [];
  caregivers.forEach((snapshot) => {
    const caregiver = snapshot.val() || {};
    if (
      caregiver.caregiver_id &&
      Array.isArray(caregiver.children) &&
      caregiver.children.includes(childId)
    ) {
      caregiverUids.push(caregiver.caregiver_id);
    }
  });

  const caregiverUsers = await Promise.all(caregiverUids.map(loadUser));
  caregiverUsers.forEach((user) => {
    if (user?.uid) recipients.set(user.uid, {uid: user.uid, user});
  });
  return [...recipients.values()];
}

const finalAttemptStatuses = new Set([
  "accepted",
  "disabled",
  "expired",
  "no_token",
  "stale_token",
]);

async function beginAttempt(
  attemptId: string,
  values: Record<string, unknown>
): Promise<{shouldSend: boolean; attemptCount: number}> {
  const attemptRef = getDb().ref(`notification_v2_delivery_attempts/${attemptId}`);
  const now = Date.now();
  const result = await attemptRef.transaction((current) => {
    if (finalAttemptStatuses.has(current?.status)) return current;
    if (current?.status === "attempting" && now - Number(current.attemptedAt) < LEASE_MS) {
      return current;
    }
    return {
      ...current,
      ...values,
      attemptCount: Number(current?.attemptCount || 0) + 1,
      attemptedAt: now,
      status: "attempting",
    };
  });
  const attempt = result.snapshot.val() || {};
  return {
    shouldSend:
      result.committed &&
      attempt.status === "attempting" &&
      Number(attempt.attemptedAt) === now,
    attemptCount: Number(attempt.attemptCount || 0),
  };
}

async function updateAttempt(
  attemptId: string,
  values: Record<string, unknown>
): Promise<void> {
  await getDb()
    .ref(`notification_v2_delivery_attempts/${attemptId}`)
    .update(values);
}

async function sendToRecipient(
  recipient: Recipient,
  body: string,
  data: Record<string, string>,
  key: string,
  dueAt: number,
  jobContext: Record<string, unknown>
): Promise<void> {
  const attemptId = safeKey(`${key}:${recipient.uid}`);
  const attempt = await beginAttempt(attemptId, {
    attemptId,
    checkpointKey: key,
    userId: recipient.uid,
    eventId: data.eventId,
    dueAt,
  });
  if (!attempt.shouldSend) return;

  if (!recipient.user.allowsPushNotifications) {
    await updateAttempt(attemptId, {status: "disabled", completedAt: Date.now()});
    await getDb().ref(`notification_v2_jobs/${attemptId}`).remove();
    return;
  }

  const tokenRef = getDb().ref(`users/${recipient.uid}/pushToken`);
  const tokenSnapshot = await tokenRef.once("value");
  if (!tokenSnapshot.exists()) {
    await updateAttempt(attemptId, {status: "no_token", completedAt: Date.now()});
    await getDb().ref(`notification_v2_jobs/${attemptId}`).remove();
    return;
  }

  try {
    const messageId = await admin.messaging().send({
      token: tokenSnapshot.val(),
      notification: {title: "Encurage", body},
      data,
      android: {
        priority: "high",
        collapseKey: data.eventId || "default",
        notification: {sound: "default", channelId: "dose_reminders"},
      },
      apns: {
        headers: {"apns-priority": "10"},
        payload: {
          aps: {
            sound: "default",
            "content-available": 1,
            "thread-id": data.eventId || "default",
          },
        },
      },
    });
    await updateAttempt(attemptId, {
      status: "accepted",
      messageId,
      completedAt: Date.now(),
    });
    await getDb().ref(`notification_v2_jobs/${attemptId}`).remove();
  } catch (error: any) {
    const code = error?.errorInfo?.code || error?.code || "unknown";
    if (code === "messaging/registration-token-not-registered") {
      await tokenRef.remove();
      await updateAttempt(attemptId, {status: "stale_token", code, completedAt: Date.now()});
      await getDb().ref(`notification_v2_jobs/${attemptId}`).remove();
      return;
    }
    await updateAttempt(attemptId, {
      status: "transient_error",
      code,
      completedAt: Date.now(),
    });
    if (attempt.attemptCount >= 5) {
      await getDb().ref(`notification_v2_jobs/${attemptId}`).set({
        ...jobContext,
        attemptId,
        status: "dead_letter",
        attemptCount: attempt.attemptCount,
        updatedAt: Date.now(),
      });
    } else {
      const retryDelay = Math.min(30, 2 ** attempt.attemptCount) * 60_000;
      await getDb().ref(`notification_v2_jobs/${attemptId}`).set({
        ...jobContext,
        attemptId,
        status: "pending",
        attemptCount: attempt.attemptCount,
        nextAttemptAt: Date.now() + retryDelay,
        updatedAt: Date.now(),
      });
    }
    logger.error("V2 push attempt failed", {
      eventId: data.eventId,
      userId: recipient.uid,
      code,
    });
  }
}

async function sendCheckpoint(
  kind: EventKind,
  eventId: string,
  event: any,
  child: any,
  ownerUid: string,
  stage: number,
  dueAt: number,
  expiresAt: number,
  prescription?: any
): Promise<void> {
  const key = checkpointKey(kind, eventId, Number(event.nextScheduledDose), stage);
  const recipients = await loadRecipients(ownerUid, event.childId);
  const screen = kind === "prescription" ? "PrimarySchedule" : "EpisodeSchedule";

  const results = await Promise.allSettled(
    recipients.map((recipient) => {
      const language = getLanguage(recipient.user);
      const body =
        kind === "prescription"
          ? prescriptionMessage(child.childName, prescription.name, stage, language)
          : asNeededMessage(child.childName, event.cycle, stage, language);
      return sendToRecipient(
        recipient,
        body,
        {
          childId: String(event.childId),
          eventId,
          screen,
          checkpointKey: key,
        },
        key,
        dueAt,
        {
          kind,
          eventId,
          childId: event.childId,
          prescriptionId: event.prescriptionId || null,
          recipientUid: recipient.uid,
          occurrenceAt: Number(event.nextScheduledDose),
          stage,
          dueAt,
          expiresAt,
        }
      );
    })
  );
  const failedAttempt = results.find((result) => result.status === "rejected");
  if (failedAttempt?.status === "rejected") throw failedAttempt.reason;
}

function eventStillMatches(current: any, observed: any): boolean {
  if (!current || current.state !== "active") return false;
  if (Number(current.nextScheduledDose) !== Number(observed.nextScheduledDose)) {
    return false;
  }
  const observedHasReminder = hasReminderState(observed);
  if (observedHasReminder) {
    return (
      Number(current.nextNotificationTime) ===
        Number(observed.nextNotificationTime) &&
      Number(current.notificationCount) === Number(observed.notificationCount)
    );
  }
  return !hasReminderState(current);
}

async function finalizeReminder(
  collection: EventCollection,
  eventId: string,
  observed: any,
  dueStage: DueStage
): Promise<boolean> {
  const eventRef = getDb().ref(`${collection}/${eventId}`);
  const result = await eventRef.transaction((current) => {
    if (current === null) return null;
    if (!eventStillMatches(current, observed)) return;
    return {
      ...current,
      nextNotificationTime: dueStage.nextNotificationTime,
      notificationCount: dueStage.nextNotificationCount,
    };
  });
  return result.committed && result.snapshot.exists();
}

async function materializePendingPrescriptionDose(
  eventId: string,
  event: any
): Promise<void> {
  const pending = event?._notificationV2PendingDose;
  if (!pending?.occurrenceKey) return;
  const currentPendingSnapshot = await getDb()
    .ref(`prescription_events/${eventId}/_notificationV2PendingDose`)
    .once("value");
  if (
    currentPendingSnapshot.val()?.occurrenceKey !== pending.occurrenceKey ||
    currentPendingSnapshot.val()?.given !== pending.given
  ) {
    return;
  }
  const doseRef = getDb().ref(`prescription_doses/${pending.occurrenceKey}`);
  await doseRef.transaction((current) => {
    if (current?.given === true && pending.given !== true) return current;
    return {...current, ...pending.dose, id: pending.occurrenceKey};
  });
  await getDb()
    .ref(`prescription_events/${eventId}/_notificationV2PendingDose`)
    .transaction((current) =>
      current?.occurrenceKey === pending.occurrenceKey &&
      current?.given === pending.given
        ? null
        : current
    );

  const resolutionSnapshot = await getDb()
    .ref(`prescription_events/${eventId}/_notificationV2LastResolution`)
    .once("value");
  const resolution = resolutionSnapshot.val() || {};
  if (
    resolution.status === "given" &&
    Number(resolution.occurrenceAt) === Number(pending.dose?.date)
  ) {
    await cleanupSkippedPrescriptionDose(
      eventId,
      Number(resolution.occurrenceAt),
      String(resolution.occurrenceKey)
    );
  }
}

async function finalizePrescriptionTerminal(
  eventId: string,
  observed: any,
  prescription: any,
  ownerTimeZone: string
): Promise<boolean> {
  const occurrenceAt = Number(observed.nextScheduledDose);
  const existingDose = await findPrescriptionOccurrenceDose(
    eventId,
    occurrenceAt
  );
  const occurrenceKey =
    existingDose?.id ||
    prescriptionDoseKey(eventId, occurrenceAt);
  const nextScheduledDose = calculateNextDoseAfter(
    prescription,
    occurrenceAt,
    ownerTimeZone
  );
  const eventRef = getDb().ref(`prescription_events/${eventId}`);
  const result = await eventRef.transaction((current) => {
    if (current === null) return null;
    if (!eventStillMatches(current, observed)) return;
    return {
      ...current,
      nextScheduledDose,
      nextNotificationTime: null,
      notificationCount: null,
      snoozeInterval: null,
      _notificationV2LastResolution: {
        occurrenceAt,
        occurrenceKey,
        status: "skipped",
        resolvedAt: Date.now(),
      },
      _notificationV2PendingDose: {
        occurrenceKey,
        given: false,
        dose: {
          prescriptionEventId: eventId,
          date: occurrenceAt,
          given: false,
          frequencyType: prescription.frequency,
          name: prescription.name,
          dose: prescription.dose,
          occurrenceKey,
        },
      },
    };
  });
  if (!result.committed || !result.snapshot.exists()) return false;
  await materializePendingPrescriptionDose(eventId, result.snapshot.val());
  return true;
}

async function finalizeAsNeededTerminal(
  eventId: string,
  observed: any
): Promise<boolean> {
  const eventRef = getDb().ref(`events/${eventId}`);
  const result = await eventRef.transaction((current) => {
    if (current === null) return null;
    if (!eventStillMatches(current, observed)) return;
    return {
      ...current,
      state: "paused",
      nextNotificationTime: null,
      notificationCount: null,
      snoozeInterval: null,
      _notificationV2LastResolution: {
        occurrenceAt: Number(observed.nextScheduledDose),
        occurrenceKey: `as_needed:${eventId}:${Number(
          observed.nextScheduledDose
        )}`,
        status: "skipped",
        resolvedAt: Date.now(),
      },
    };
  });
  return result.committed && result.snapshot.exists();
}

async function loadPrescription(prescriptionId: string): Promise<any> {
  const snapshot = await getDb()
    .ref(`prescription/${prescriptionId}`)
    .once("value");
  if (!snapshot.exists()) {
    throw new Error(`Prescription not found: ${prescriptionId}`);
  }
  return snapshot.val();
}

async function recordFinalizedCheckpoint(
  kind: EventKind,
  eventId: string,
  event: any,
  stage: number,
  dueAt: number,
  supersededStages: number[],
  deliveryDecision: "attempted" | "suppressed_late" | "not_needed_given"
): Promise<void> {
  await getDb().ref(`notification_v2_runtime/${kind}/${eventId}`).update({
    lastCheckpointKey: checkpointKey(
      kind,
      eventId,
      Number(event.nextScheduledDose),
      stage
    ),
    lastCheckpointDueAt: dueAt,
    lastDeliveryDecision: deliveryDecision,
    supersededStages,
    updatedAt: Date.now(),
  });
}

async function enqueueTerminalSettlement(
  kind: EventKind,
  eventId: string,
  event: any,
  dueStage: DueStage
): Promise<void> {
  const occurrenceAt = Number(event.nextScheduledDose);
  const taskId = safeKey(
    `terminal:${kind}:${eventId}:${occurrenceAt}:${dueStage.dueAt}`
  );
  const task: TerminalSettlementTask = {
    kind,
    eventId,
    childId: String(event.childId),
    occurrenceAt,
    dueAt: dueStage.dueAt,
  };

  try {
    await getFunctions()
      .taskQueue<TerminalSettlementTask>(
        "locations/us-central1/functions/settleNotificationV2Terminal"
      )
      .enqueue(task, {
        id: taskId,
        scheduleTime: new Date(
          Math.max(Date.now(), terminalSettlementAt(dueStage.dueAt))
        ),
        dispatchDeadlineSeconds: 60,
      });
    logger.info("V2 terminal settlement enqueued", {
      eventId,
      kind,
      occurrenceAt,
      dueAt: dueStage.dueAt,
    });
  } catch (error: any) {
    if (
      error?.code === "functions/task-already-exists" ||
      error?.errorInfo?.code === "functions/task-already-exists"
    ) {
      return;
    }
    throw error;
  }
}

async function processCanaryEvent(
  collection: EventCollection,
  candidate: RoutedEvent
): Promise<void> {
  const kind = getEventKind(collection);
  await repairEventParentId(
    collection,
    candidate.eventId,
    parentIdFromEvent(candidate.event),
    candidate.ownerUid
  );
  const executionId = randomUUID();
  const claimed = await acquireLease(kind, candidate.eventId, executionId, Date.now());
  if (!claimed) {
    logger.warn("V2 candidate lease not acquired", {
      eventId: candidate.eventId,
      collection,
    });
    return;
  }

  try {
    logger.info("V2 accepted routed event", {
      eventId: candidate.eventId,
      collection,
      ownerUid: candidate.ownerUid,
      notificationRoute: candidate.routeReason,
      notificationBucket: candidate.routeBucket,
    });
    for (let hop = 0; hop < MAX_RECONCILIATION_HOPS; hop++) {
      const eventSnapshot = await getDb()
        .ref(`${collection}/${candidate.eventId}`)
        .once("value");
      if (!eventSnapshot.exists()) return;
      const event = eventSnapshot.val();
      if (event.state !== "active") return;

      if (collection === "prescription_events") {
        await materializePendingPrescriptionDose(candidate.eventId, event);
      }

      const dueStage = resolveDueStage(event, Date.now());
      if (!dueStage) {
        logger.info("V2 candidate no longer due after claim", {
          eventId: candidate.eventId,
          collection,
          nextScheduledDose: event.nextScheduledDose || null,
          nextNotificationTime: event.nextNotificationTime || null,
          notificationCount: event.notificationCount || null,
        });
        return;
      }

      if (dueStage.stage === 4) {
        await enqueueTerminalSettlement(
          kind,
          candidate.eventId,
          event,
          dueStage
        );
        return;
      }

      const prescription =
        kind === "prescription"
          ? await loadPrescription(event.prescriptionId)
          : undefined;
      const parent = await loadUser(candidate.ownerUid);
      if (!parent) throw new Error(`Owner not found: ${candidate.ownerUid}`);

      await sendCheckpoint(
        kind,
        candidate.eventId,
        event,
        candidate.child,
        candidate.ownerUid,
        dueStage.stage,
        dueStage.dueAt,
        Number(dueStage.nextNotificationTime),
        prescription
      );

      const finalized = await finalizeReminder(
        collection,
        candidate.eventId,
        event,
        dueStage
      );

      if (!finalized) {
        logger.warn("V2 checkpoint finalization rejected", {
          eventId: candidate.eventId,
          collection,
          stage: dueStage.stage,
          observedNextScheduledDose: event.nextScheduledDose || null,
          observedNextNotificationTime: event.nextNotificationTime || null,
          observedNotificationCount: event.notificationCount || null,
        });
        return;
      }
      await recordFinalizedCheckpoint(
        kind,
        candidate.eventId,
        event,
        dueStage.stage,
        dueStage.dueAt,
        dueStage.supersededStages,
        "attempted"
      );

      logger.info("V2 checkpoint processed", {
        eventId: candidate.eventId,
        kind,
        stage: dueStage.stage,
        dueAt: dueStage.dueAt,
        sent: true,
        supersededStages: dueStage.supersededStages,
      });

      return;
    }

    logger.error("V2 reconciliation hop limit reached", {
      eventId: candidate.eventId,
      collection,
      maxHops: MAX_RECONCILIATION_HOPS,
    });
  } finally {
    await releaseLease(kind, candidate.eventId, executionId);
  }
}

async function runWorker(
  collection: EventCollection,
  workerKind: WorkerKind
): Promise<void> {
  if (!notificationV2RoutingEnabled) return;
  const startedAt = Date.now();
  const liveRangeStart = startedAt - LIVE_DISCOVERY_LOOKBACK_MS;
  const live = await loadLiveCanaryEvents(
    collection,
    workerKind,
    liveRangeStart,
    startedAt
  );
  await runBatches(live.candidates, (candidate) =>
    processCanaryEvent(collection, candidate)
  );

  logger.info("Notification V2 worker completed", {
    collection,
    workerKind,
    candidateCount: live.candidates.length,
    liveCandidateCount: live.candidates.length,
    liveScannedCount: live.scannedCount,
    livePageCount: live.pageCount,
    durationMs: Date.now() - startedAt,
  });
}

async function runRecoveryWorker(collection: EventCollection): Promise<void> {
  if (!notificationV2RoutingEnabled) return;
  const startedAt = Date.now();
  const stale = await loadStaleRoutedEvents(
    collection,
    startedAt - LIVE_DISCOVERY_LOOKBACK_MS
  );

  await runBatches(stale.initial, (candidate) =>
    processCanaryEvent(collection, candidate)
  );
  await runBatches(stale.reminder, (candidate) =>
    processCanaryEvent(collection, candidate)
  );

  logger.info("Notification V2 recovery worker completed", {
    collection,
    candidateCount: stale.initial.length + stale.reminder.length,
    initialCandidateCount: stale.initial.length,
    reminderCandidateCount: stale.reminder.length,
    durationMs: Date.now() - startedAt,
  });
}

const scheduleOptions = {
  schedule: "*/1 * * * *",
  timeZone: "America/New_York",
  timeoutSeconds: 300,
  memory: "512MiB" as const,
  region: "us-central1",
};

const recoveryScheduleOptions = {
  ...scheduleOptions,
  schedule: "*/1 * * * *",
};

export const checkEventDosesV2Cron = onSchedule(scheduleOptions, async () => {
  await runWorker("events", "initial");
});

export const checkNextNotificationTimeV2Cron = onSchedule(
  scheduleOptions,
  async () => {
    await runWorker("events", "reminder");
  }
);

export const processPrescriptionEventsV2Cron = onSchedule(
  scheduleOptions,
  async () => {
    await runWorker("prescription_events", "initial");
  }
);

export const processPrescriptionNextNotificationV2Cron = onSchedule(
  scheduleOptions,
  async () => {
    await runWorker("prescription_events", "reminder");
  }
);

export const reconcileEventNotificationsV2Cron = onSchedule(
  recoveryScheduleOptions,
  async () => {
    await runRecoveryWorker("events");
  }
);

export const reconcilePrescriptionNotificationsV2Cron = onSchedule(
  recoveryScheduleOptions,
  async () => {
    await runRecoveryWorker("prescription_events");
  }
);

async function processTerminalSettlement(
  task: TerminalSettlementTask
): Promise<void> {
  const {kind, eventId, occurrenceAt, dueAt} = task;
  if (
    (kind !== "as_needed" && kind !== "prescription") ||
    !eventId ||
    !Number.isFinite(Number(occurrenceAt)) ||
    !Number.isFinite(Number(dueAt))
  ) {
    logger.error("V2 terminal settlement received invalid task", {task});
    return;
  }
  if (Date.now() < terminalSettlementAt(dueAt)) {
    throw new Error(`Terminal settlement dispatched early: ${eventId}`);
  }

  const collection: EventCollection =
    kind === "prescription" ? "prescription_events" : "events";
  const childSnapshot = await getDb().ref(`children/${task.childId}`).once("value");
  if (!childSnapshot.exists()) return;
  const child = childSnapshot.val() || {};
  const parentId = parentIdFromChild(child);
  if (!parentId || !isNotificationV2Owner(parentId)) return;

  const executionId = randomUUID();
  const claimed = await acquireLease(kind, eventId, executionId, Date.now());
  if (!claimed) throw new Error(`Terminal settlement lease unavailable: ${eventId}`);

  try {
    const eventRef = getDb().ref(`${collection}/${eventId}`);
    const eventSnapshot = await eventRef.once("value");
    if (!eventSnapshot.exists()) return;
    const event = eventSnapshot.val() || {};
    if (String(event.childId || "") !== String(task.childId)) return;
    const parent = await loadUser(parentId);
    if (!parent) throw new Error(`Owner not found: ${parentId}`);
    const prescription =
      kind === "prescription"
        ? await loadPrescription(event.prescriptionId)
        : undefined;
    const resolution = event._notificationV2LastResolution;
    const resolutionMatches =
      Number(resolution?.occurrenceAt) === Number(occurrenceAt);

    if (resolutionMatches && resolution.status === "given") return;
    if (resolutionMatches && resolution.status === "skipped") {
      if (kind === "prescription") {
        const givenDose = await findPrescriptionOccurrenceDose(
          eventId,
          occurrenceAt
        );
        if (givenDose?.dose?.given === true) {
          await reconcileGivenPrescriptionOccurrence(
            eventId,
            occurrenceAt,
            givenDose.id
          );
          return;
        }
      } else if (
        Number(event.nextScheduledDose) !== Number(occurrenceAt)
      ) {
        return;
      }
      const shouldSend = Date.now() - dueAt <= TERMINAL_SEND_GRACE_MS;
      if (shouldSend) {
        await sendCheckpoint(
          kind,
          eventId,
          {...event, childId: task.childId, nextScheduledDose: occurrenceAt},
          child,
          parentId,
          4,
          dueAt,
          dueAt + TERMINAL_SEND_GRACE_MS,
          prescription
        );
      }
      await recordFinalizedCheckpoint(
        kind,
        eventId,
        {...event, nextScheduledDose: occurrenceAt},
        4,
        dueAt,
        [],
        shouldSend ? "attempted" : "suppressed_late"
      );
      return;
    }
    if (Number(event.nextScheduledDose) !== Number(occurrenceAt)) return;
    if (event.state !== "active") return;

    const dueStage = resolveDueStage(event, Date.now());
    if (
      !dueStage ||
      dueStage.stage !== 4 ||
      Number(dueStage.dueAt) !== Number(dueAt)
    ) {
      return;
    }

    if (kind === "prescription") {
      const existingDose = await findPrescriptionOccurrenceDose(
        eventId,
        occurrenceAt
      );
      if (existingDose?.dose?.given === true) {
        const reconciled = await reconcileGivenPrescriptionOccurrence(
          eventId,
          occurrenceAt,
          existingDose.id
        );
        if (reconciled) {
          await recordFinalizedCheckpoint(
            kind,
            eventId,
            event,
            4,
            dueAt,
            dueStage.supersededStages,
            "not_needed_given"
          );
        }
        return;
      }
    } else if (resolutionMatches && resolution.status === "given") {
      return;
    }

    const finalized =
      kind === "prescription"
        ? await finalizePrescriptionTerminal(
            eventId,
            event,
            prescription,
            parent.timeZone || prescription.timeZone || "UTC"
          )
        : await finalizeAsNeededTerminal(eventId, event);
    if (!finalized) return;

    if (kind === "prescription") {
      const givenAfterFinalize = await findPrescriptionOccurrenceDose(
        eventId,
        occurrenceAt
      );
      if (givenAfterFinalize?.dose?.given === true) {
        await reconcileGivenPrescriptionOccurrence(
          eventId,
          occurrenceAt,
          givenAfterFinalize.id
        );
        await recordFinalizedCheckpoint(
          kind,
          eventId,
          event,
          4,
          dueAt,
          dueStage.supersededStages,
          "not_needed_given"
        );
        return;
      }
    } else {
      const latestEventSnapshot = await getDb()
        .ref(`events/${eventId}`)
        .once("value");
      const latestEvent = latestEventSnapshot.val() || {};
      const latestResolution = latestEvent._notificationV2LastResolution || {};
      if (
        Number(latestEvent.nextScheduledDose) !== Number(occurrenceAt) ||
        (Number(latestResolution.occurrenceAt) === Number(occurrenceAt) &&
          latestResolution.status === "given")
      ) {
        return;
      }
    }

    const shouldSend = Date.now() - dueAt <= TERMINAL_SEND_GRACE_MS;
    if (shouldSend) {
      await sendCheckpoint(
        kind,
        eventId,
        event,
        child,
        parentId,
        4,
        dueAt,
        dueAt + TERMINAL_SEND_GRACE_MS,
        prescription
      );
    }
    await recordFinalizedCheckpoint(
      kind,
      eventId,
      event,
      4,
      dueAt,
      dueStage.supersededStages,
      shouldSend ? "attempted" : "suppressed_late"
    );
  } finally {
    await releaseLease(kind, eventId, executionId);
  }
}

export const settleNotificationV2Terminal = onTaskDispatched<TerminalSettlementTask>(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 120,
    retryConfig: {
      maxAttempts: 10,
      minBackoffSeconds: 5,
      maxBackoffSeconds: 60,
      maxRetrySeconds: 900,
    },
    rateLimits: {
      maxConcurrentDispatches: 50,
      maxDispatchesPerSecond: 100,
    },
  },
  async (request) => {
    await processTerminalSettlement(request.data);
  }
);

async function processRetryJob(jobSnapshot: admin.database.DataSnapshot) {
  const job = jobSnapshot.val() || {};
  if (Number(job.expiresAt) <= Date.now()) {
    await updateAttempt(job.attemptId, {
      status: "expired",
      completedAt: Date.now(),
    });
    await jobSnapshot.ref.remove();
    return;
  }
  const kind = job.kind as EventKind;
  const collection: EventCollection =
    kind === "prescription" ? "prescription_events" : "events";
  const eventSnapshot = await getDb()
    .ref(`${collection}/${job.eventId}`)
    .once("value");
  const childSnapshot = await getDb().ref(`children/${job.childId}`).once("value");
  const recipient = await loadUser(job.recipientUid);
  if (!eventSnapshot.exists() || !childSnapshot.exists() || !recipient) {
    await jobSnapshot.ref.update({
      status: "dead_letter",
      error: "missing_retry_data",
      nextAttemptAt: null,
      updatedAt: Date.now(),
    });
    return;
  }

  const event = eventSnapshot.val();
  const child = childSnapshot.val();
  const ownerUid = child.parentId || child.parent_id;
  if (!isNotificationV2Owner(ownerUid)) {
    await jobSnapshot.ref.remove();
    return;
  }

  const language = getLanguage(recipient);
  const prescription =
    kind === "prescription"
      ? await loadPrescription(job.prescriptionId)
      : undefined;
  const body =
    kind === "prescription"
      ? prescriptionMessage(child.childName, prescription.name, job.stage, language)
      : asNeededMessage(child.childName, event.cycle, job.stage, language);
  const key = checkpointKey(
    kind,
    job.eventId,
    Number(job.occurrenceAt),
    Number(job.stage)
  );
  await sendToRecipient(
    {uid: job.recipientUid, user: recipient},
    body,
    {
      childId: String(job.childId),
      eventId: String(job.eventId),
      screen: kind === "prescription" ? "PrimarySchedule" : "EpisodeSchedule",
      checkpointKey: key,
    },
    key,
    Number(job.dueAt),
    job
  );
}

export const retryNotificationV2Cron = onSchedule(
  scheduleOptions,
  async () => {
    if (!notificationV2RoutingEnabled) return;
    const snapshot = await getDb()
      .ref("notification_v2_jobs")
      .orderByChild("nextAttemptAt")
      .startAt(0)
      .endAt(Date.now())
      .limitToFirst(100)
      .once("value");
    const jobs: admin.database.DataSnapshot[] = [];
    snapshot.forEach((jobSnapshot) => {
      if (jobSnapshot.val()?.status === "pending") jobs.push(jobSnapshot);
    });
    await runBatches(jobs, processRetryJob);
  }
);
