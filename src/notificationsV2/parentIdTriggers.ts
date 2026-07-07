import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {onValueCreated} from "firebase-functions/v2/database";
import {
  isNotificationV2Owner,
  notificationV2RoutingEnabled,
} from "./routing";
import {parentIdFromChild, parentIdFromEvent} from "./discovery";

type EventCollection = "events" | "prescription_events";

const triggerOptions = (collection: EventCollection) => ({
  ref: `/${collection}/{eventId}`,
  instance: "encurage-new-default-rtdb",
  region: "us-central1",
  memory: "256MiB" as const,
  timeoutSeconds: 60,
  maxInstances: 10,
});

async function populateRoutedEventParentId(
  collection: EventCollection,
  eventId: string,
  eventSnapshot: admin.database.DataSnapshot
): Promise<void> {
  if (!notificationV2RoutingEnabled) return;

  const event = eventSnapshot.val() || {};
  const childId = String(event.childId || "");
  if (!childId) {
    logger.warn("V2 parentId trigger found event without childId", {
      collection,
      eventId,
    });
    return;
  }

  const childSnapshot = await admin
    .app()
    .database()
    .ref(`children/${childId}`)
    .once("value");
  if (!childSnapshot.exists()) {
    logger.warn("V2 parentId trigger could not find child", {
      collection,
      eventId,
      childId,
    });
    return;
  }

  const parentId = parentIdFromChild(childSnapshot.val());
  if (!parentId) {
    logger.warn("V2 parentId trigger found child without parent", {
      collection,
      eventId,
      childId,
    });
    return;
  }
  if (!isNotificationV2Owner(parentId)) return;
  if (parentIdFromEvent(event) === parentId) return;

  await eventSnapshot.ref.child("parentId").set(parentId);
  logger.info("V2 populated event parentId", {collection, eventId});
}

export const populateEventParentIdV2 = onValueCreated(
  triggerOptions("events"),
  async (event) => {
    await populateRoutedEventParentId(
      "events",
      event.params.eventId,
      event.data
    );
  }
);

export const populatePrescriptionEventParentIdV2 = onValueCreated(
  triggerOptions("prescription_events"),
  async (event) => {
    await populateRoutedEventParentId(
      "prescription_events",
      event.params.eventId,
      event.data
    );
  }
);
