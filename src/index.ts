// function file
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import * as v1 from "firebase-functions/v1";
// import { onMessagePublished } from "firebase-functions/v2/pubsub";
import { defineSecret } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, CallableRequest } from "firebase-functions/v2/https";
import moment from "moment-timezone";
import axios from "axios";
import { google } from "googleapis";

logger.log("[startup] container code loaded at", new Date().toISOString());
// 🔥 Log any uncaught runtime issues before container dies
process.on("uncaughtException", (err) => {
  logger.error("💥 uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  logger.error("💥 unhandledRejection", reason);
});

export const ONCURE_SERVICE_ACCOUNT_JSON = defineSecret(
  "ONCURE_SERVICE_ACCOUNT_JSON"
);

// Default Encurage app
if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://encurage-new-default-rtdb.firebaseio.com",
  });
}

// Safe onCureApp initialization
try {
  if (
    process.env.ONCURE_SERVICE_ACCOUNT_JSON &&
    !admin.apps.some((app) => app.name === "onCureApp")
  ) {
    const serviceAccount = JSON.parse(process.env.ONCURE_SERVICE_ACCOUNT_JSON);

    admin.initializeApp(
      {
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://oncure-app.firebaseio.com/",
      },
      "onCureApp"
    );

    console.log("✅ onCureApp initialized");
  } else {
    console.log(
      "⚠️ Skipping onCureApp initialization (already exists or missing secret)"
    );
  }
} catch (err) {
  console.error("❌ Failed to initialize onCureApp:", err);
}

export function getOnCureDb(): admin.database.Database | null {
  if (admin.apps.some((app) => app.name === "onCureApp")) {
    return admin.app("onCureApp").database();
  }

  console.warn("⚠️ onCureApp is not initialized");
  return null;
}

// Get the database reference for each
const db = admin.app().database();
// const onCureDb = admin.app("onCureApp").database();
const onCureDb = getOnCureDb();

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

/*
export const newChildAdded = v1.database
  .ref("children/{childId}")
  .onCreate(async (snapshot, context) => {
    const childId = context.params.childId; // Get the childId from the context
    // const child = snapshot.val();

    // Call the function to create a folder with the same childId
    await addFolderToChild(childId, "general");

    return null; // Indicate completion
  });

*/

/*
Function to add a folder with a random ID to the child's folder array
const addFolderToChild = async (childId, folderName) => {
  // Reference to the child's folders array
  const folderRef = db.ref(`/folders/${childId}`);

  // Push a new folder with a random ID
  const newFolderRef = folderRef.push(); // This generates a unique ID for the folder

  await newFolderRef.set({
    id: newFolderRef.key, // Use the generated key as the folder ID
    name: folderName,
    createdAt: admin.database.ServerValue.TIMESTAMP,
  });

  return newFolderRef.key; // Return the unique key of the new folder
};
*/

export const deleteExpiredCodesCron = onSchedule(
  {
    schedule: "0 0 * * *", // Every day at midnight
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    logger.log("🧹 deleteExpiredCodesCron started");

    const caregiverInviteRef = db.ref("caregiver_invite");
    const currentTime = Date.now();

    try {
      const snapshot = await caregiverInviteRef.once("value");

      if (!snapshot.exists()) {
        logger.log("📭 No caregiver invites found.");
        return;
      }

      const expiredDeletes: Promise<void>[] = [];

      snapshot.forEach((childSnapshot) => {
        const inviteData = childSnapshot.val();
        if (inviteData.expirationTime <= currentTime) {
          expiredDeletes.push(childSnapshot.ref.remove());
        }
      });

      await Promise.all(expiredDeletes);

      logger.log("✅ Expired codes deleted successfully.");
      return;
    } catch (error: any) {
      logger.error("❌ Error deleting expired codes:", {
        message: error.message,
        stack: error.stack,
      });
      throw new Error("An error occurred during expired code cleanup.");
    }
  }
);

export const checkEventDosesCron = onSchedule(
  {
    schedule: "*/1 * * * *",
    timeZone: "America/New_York",
    timeoutSeconds: 300,
    memory: "512MiB",
    region: "us-central1",
  },
  async () => {
    const start = Date.now();
    logger.log("🕒 checkEventDosesCron started");

    try {
      await checkEventDoses();
      logger.log(`✅ checkEventDosesCron completed in ${Date.now() - start}ms`);
    } catch (err) {
      logger.error("❌ checkEventDosesCron failed", err);
    }
  }
);

export const checkNextNotificationTimeCron = onSchedule(
  {
    schedule: "*/1 * * * *",
    timeZone: "America/New_York",
    timeoutSeconds: 300,
    memory: "512MiB",
    region: "us-central1",
  },
  async () => {
    const start = Date.now();
    logger.log("🕒 checkNextNotificationTimeCron started");

    try {
      await checkNextNotificationTime();
      logger.log(
        `✅ checkNextNotificationTimeCron completed in ${Date.now() - start}ms`
      );
    } catch (err) {
      logger.error("❌ checkNextNotificationTimeCron failed", err);
    }
  }
);

export const processPrescriptionEventsCron = onSchedule(
  {
    schedule: "*/1 * * * *",
    timeZone: "America/New_York",
    timeoutSeconds: 300,
    memory: "512MiB",
    region: "us-central1",
  },
  async () => {
    const start = Date.now();
    logger.log("🕒 processPrescriptionEvents started");

    try {
      await processPrescriptionEvents();
      logger.log(
        `✅ processPrescriptionEvents completed in ${Date.now() - start}ms`
      );
    } catch (err) {
      logger.error("❌ processPrescriptionEvents failed", err);
    }
  }
);

// IMPORTANT: Your in-code cap must be *lower* than PLATFORM_TIMEOUT_SECONDS.
// 285s gives you ~15s of safety margin for Node’s event loop jitter, log flushing, etc.
const CAP_MS = Number(process.env.PRESCRIPTION_CRON_CAP_MS) || 285_000; // 4m45s

export const processPrescriptionNextNotificationCron = onSchedule(
  {
    schedule: "*/1 * * * *",
    timeZone: "America/New_York",
    timeoutSeconds: 540, // <-- bump to 540 for diagnostics
    memory: "1GiB", // <-- optional but good to rule out OOM
    region: "us-central1",
    minInstances: 1,
    concurrency: 1,
  },
  async () => {
    const start = Date.now();

    // ✅ 1. Log immediately before any await
    logger.log("🕒 cron:start", {
      t: new Date(start).toISOString(),
      capMs: CAP_MS,
      timeoutSeconds: 540,
      revision: process.env.K_REVISION,
      instance: process.env.K_INSTANCE,
      node: process.version,
    });
    // logger.log("🕑 start:", new Date(start).toISOString());

    // ✅ 2. Quick proof that the event loop is alive
    setTimeout(() => logger.log("⏱️ cron:loop-alive-after-1s"), 1000);

    // ✅ 3. Heartbeat every 20s while the job runs
    const hbStart = Date.now();
    const hb = setInterval(() => {
      logger.log("💓 cron:hb", { sinceMs: Date.now() - hbStart });
    }, 20_000);

    let timedOut = false;

    try {
      await Promise.race([
        processPrescriptionNextNotificationTime(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, CAP_MS)
        ),
      ]);
      const dur = Date.now() - start;
      if (timedOut) {
        logger.warn(`⏱️ Hit cron cap at ${CAP_MS}ms; returned early.`, {
          durationMs: dur,
        });
      } else {
        logger.log(`✅ cron finished in ${dur}ms`);
      }
    } catch (err) {
      logger.error("❌ cron failed", err);
      throw err;
    } finally {
      clearInterval(hb); // ✅ always stop the heartbeat
      logger.log("🏁 cron:end", {
        totalDurationMs: Date.now() - start,
        timedOut,
      });
    }
  }
);

export const checkEventDoses = async () => {
  const currentTime = Date.now();
  const startOfMinute = getStartOfMinute(currentTime);
  const endOfMinute = getEndOfMinute(currentTime);

  const snapshot = await db
    .ref("events")
    .orderByChild("nextScheduledDose")
    .startAt(startOfMinute)
    .endAt(endOfMinute)
    .once("value");

  const promises: Promise<any>[] = [];

  snapshot.forEach((childSnapshot) => {
    const event = childSnapshot.val();
    const eventId = childSnapshot.key;
    if (event.state === "active" && !event.nextNotificationTime) {
      const promise = (async () => {
        let child: any;
        let parent: any;
        let notificationBody = "";

        // Step 1: Fetch child data
        try {
          child = await getChild(event.childId);
          if (!child) {
            throw new Error(`Child not found for ID ${event.childId}`);
          }
        } catch (error) {
          logger.error(`Error fetching child for event ${eventId}:`, error);
        }

        // Step 2: Fetch parent data
        try {
          if (child) {
            parent = await getUser(child.parentId);
            if (!parent) {
              throw new Error(`Parent not found for ID ${child.parentId}`);
            }
          }
        } catch (error) {
          logger.error(`Error fetching parent for event ${eventId}:`, error);
        }

        // Step 3: Prepare notification message
        try {
          if (child) {
            const parentLanguage = getPnLanguage(parent);
            const cycle = translateCycleName(event.cycle, parentLanguage);
            notificationBody =
              parentLanguage === "es"
                ? `${child.childName} puede recibir la siguiente dosis de ${cycle} ahora. Pulsa aquí para administrar la dosis.`
                : `${child.childName} can get the next ${cycle} dose now. Tap to give the dose.`;
          }
        } catch (error) {
          logger.error(
            `Error building notification for event ${eventId}:`,
            error
          );
        }

        // Step 4: Send notification to parent if allowed
        try {
          if (parent && parent.allowsPushNotifications && notificationBody) {
            await sendPushNotificationsToUser(parent.uid, notificationBody, {
              childId: event.childId,
              eventId: eventId,
              screen: "EpisodeSchedule",
            });
          }
        } catch (error) {
          logger.error(
            `Error sending notification to parent ${parent ? parent.uid : "unknown"
            } for event ${eventId}:`,
            error
          );
        }

        // Step 5: Send notifications to eligible care team members
        try {
          if (child) {
            const careFamilyMembers = await fetchCareFamilyMembers(
              child.parentId,
              event.childId
            );
            const eligibleMembers = careFamilyMembers.filter(
              (member) => member.allowsPushNotifications
            );
            const memberResults = await Promise.allSettled(
              eligibleMembers.map((member) => {
                const memberLanguage = getPnLanguage({
                  pnLanguage: member.pnLanguage,
                });
                const cycle = translateCycleName(event.cycle, memberLanguage);
                const memberBody =
                  memberLanguage === "es"
                    ? `${child.childName} puede recibir la siguiente dosis de ${cycle} ahora. Pulsa aquí para administrar la dosis.`
                    : `${child.childName} can get the next ${cycle} dose now. Tap to give the dose.`;

                return sendPushNotificationsToUser(member.uid, memberBody, {
                  childId: event.childId,
                  eventId: eventId,
                  screen: "EpisodeSchedule",
                });
              })
            );
            memberResults.forEach((result) => {
              if (result.status === "rejected") {
                logger.error(
                  `Error sending notification to a care team member for event ${eventId}:`,
                  result.reason
                );
              }
            });
          }
        } catch (error) {
          logger.error(
            `Error processing care team notifications for event ${eventId}:`,
            error
          );
        }

        // Step 6: Update nextNotificationTime and notificationCount.
        // This update should occur regardless of previous errors.
        const nextNotificationTime = currentTime + 10 * 60 * 1000; // Add 10 minutes
        try {
          return await db
            .ref(`events/${childSnapshot.key}`)
            .update({ nextNotificationTime, notificationCount: 1 });
        } catch (updateError) {
          logger.error(`Error updating event ${eventId}:`, updateError);
        }
      })();
      promises.push(promise);
    }
  });

  await Promise.all(promises);
  return null;
};

export const checkNextNotificationTime = async () => {
  const currentTime = Date.now();
  const startOfMinute = getStartOfMinute(currentTime);
  const endOfMinute = getEndOfMinute(currentTime);

  const snapshot = await db
    .ref("events")
    .orderByChild("nextNotificationTime")
    .startAt(startOfMinute)
    .endAt(endOfMinute)
    .once("value");

  const promises: Promise<any>[] = [];

  snapshot.forEach((childSnapshot) => {
    const event = childSnapshot.val();
    const eventId = childSnapshot.key;

    if (
      event.state === "active" &&
      event.nextNotificationTime &&
      event.notificationCount <= 5
    ) {
      const promise = (async () => {
        let child: any;
        let parent: any;
        let notificationBody = "";

        // 1) Get child data
        try {
          child = await getChild(event.childId);
          if (!child) {
            throw new Error(`Child not found for ID ${event.childId}`);
          }
        } catch (error) {
          logger.error(`Error fetching child for event ${eventId}:`, error);
        }

        // 2) Get parent data
        try {
          if (child) {
            parent = await getUser(child.parentId);
            if (!parent) {
              throw new Error(`Parent not found for ID ${child.parentId}`);
            }
          }
        } catch (error) {
          logger.error(`Error fetching parent for event ${eventId}:`, error);
        }

        // 3) Prepare notification message using child and event info
        try {
          if (child) {
            // Send notification to parent if they allow push notifications
            const parentLanguage = getPnLanguage(parent);
            notificationBody = getNotificationMessage(
              child,
              event,
              parentLanguage
            );
          }
        } catch (error) {
          logger.error(
            `Error building notification message for event ${eventId}:`,
            error
          );
        }

        // 4) Send notification to parent if allowed
        try {
          if (parent && parent.allowsPushNotifications && notificationBody) {
            await sendPushNotificationsToUser(parent.uid, notificationBody, {
              childId: event.childId,
              eventId: eventId,
              screen: "EpisodeSchedule",
            });
          }
        } catch (error) {
          logger.error(
            `Error sending notification to parent ${parent ? parent.uid : "unknown"
            } for event ${eventId}:`,
            error
          );
        }

        // 5) Send notifications to eligible care team members
        try {
          if (child) {
            const careFamilyMembers = await fetchCareFamilyMembers(
              child.parentId,
              event.childId
            );
            const eligibleMembers = careFamilyMembers.filter(
              (member) => member.allowsPushNotifications
            );
            const memberResults = await Promise.allSettled(
              eligibleMembers.map((member) => {
                const memberLanguage = getPnLanguage({
                  pnLanguage: member.pnLanguage,
                });
                const bodyForMember = getNotificationMessage(
                  child,
                  event,
                  memberLanguage
                );
                return sendPushNotificationsToUser(member.uid, bodyForMember, {
                  childId: event.childId,
                  eventId: eventId,
                  screen: "EpisodeSchedule",
                });
              })
            );
            memberResults.forEach((result) => {
              if (result.status === "rejected") {
                logger.error(
                  `Error sending notification to care team member for event ${eventId}:`,
                  result.reason
                );
              }
            });
          }
        } catch (error) {
          logger.error(
            `Error processing care team notifications for event ${eventId}:`,
            error
          );
        }

        // 6) Update nextNotificationTime and notificationCount using your updateEventNotificationCount function.
        try {
          return await updateEventNotificationCount(
            event,
            childSnapshot.key,
            currentTime
          );
        } catch (updateError) {
          logger.error(
            `Error updating event ${eventId} in checkNextNotificationTime:`,
            updateError
          );
        }
      })();
      promises.push(promise);
    }
  });

  await Promise.all(promises);
  return null;
};

export const processPrescriptionEvents = async () => {
  const currentTime = Date.now();
  const startOfMinute = getStartOfMinute(currentTime);
  const endOfMinute = getEndOfMinute(currentTime);

  const snapshot = await db
    .ref("prescription_events")
    .orderByChild("nextScheduledDose")
    .startAt(startOfMinute)
    .endAt(endOfMinute)
    .once("value");

  const promises: Promise<any>[] = [];

  snapshot.forEach((childSnapshot) => {
    const event = childSnapshot.val();
    const eventId = childSnapshot.key;

    if (event.state === "active" && !event.nextNotificationTime) {
      const promise = (async () => {
        // Declare local variables for this event's processing.
        let child: any;
        let parent: any;
        let prescription: any;
        const notificationBodyParts: {
          childName?: string;
          prescriptionName?: string;
        } = {};

        // Attempt to fetch child data.
        try {
          child = await getChild(event.childId);
          if (!child) {
            throw new Error(`Child not found for ID ${event.childId}`);
          }
          notificationBodyParts.childName = child.childName;
        } catch (error) {
          logger.error(`Error fetching child for event ${eventId}:`, error);
        }

        // Attempt to fetch parent data.
        try {
          if (child) {
            parent = await getUser(child.parentId);
            if (!parent) {
              throw new Error(`Parent not found for ID ${child.parentId}`);
            }
          }
        } catch (error) {
          logger.error(`Error fetching parent for event ${eventId}:`, error);
        }

        // Attempt to fetch prescription details.
        try {
          prescription = await getPrescription(event.prescriptionId);
          if (prescription) {
            notificationBodyParts.prescriptionName = prescription.name;
          }
        } catch (error) {
          logger.error(
            `Error fetching prescription for event ${eventId}:`,
            error
          );
        }

        // Prepare notification message if we have necessary parts.
        let notificationBody = "";
        if (
          notificationBodyParts.childName &&
          notificationBodyParts.prescriptionName
        ) {
          const parentLanguage = getPnLanguage(parent);
          const med = capitalizeFirstLetter(notificationBodyParts.prescriptionName);
          notificationBody =
            parentLanguage === "es"
              ? `Es tiempo de la siguiente dosis de ${med} para ${notificationBodyParts.childName}. Pulsa para administrar la dosis.`
              : `It's time for ${notificationBodyParts.childName}'s next dose of ${med}. Tap to give the dose.`;
        }

        // Send notification to parent if allowed.
        try {
          if (parent && parent.allowsPushNotifications && notificationBody) {
            await sendPushNotificationsToUser(parent.uid, notificationBody, {
              childId: event.childId,
              eventId: eventId,
              screen: "PrimarySchedule",
            });
          }
        } catch (error) {
          logger.error(
            `Error sending notification to parent ${parent ? parent.uid : "unknown"
            }`,
            error
          );
        }

        // Send notifications to eligible care team members.
        try {
          if (child) {
            const careFamilyMembers = await fetchCareFamilyMembers(
              child.parentId,
              event.childId
            );
            const eligibleMembers = careFamilyMembers.filter(
              (member) => member.allowsPushNotifications
            );
            const memberResults = await Promise.allSettled(
              eligibleMembers.map((member) => {
                const memberLanguage = getPnLanguage({
                  pnLanguage: member.pnLanguage,
                });
                const med = capitalizeFirstLetter(
                  notificationBodyParts.prescriptionName as string
                );
                const memberBody =
                  memberLanguage === "es"
                    ? `Es tiempo de la siguiente dosis de ${med} para ${notificationBodyParts.childName}. Pulsa para administrar la dosis.`
                    : `It's time for ${notificationBodyParts.childName}'s next dose of ${med}. Tap to give the dose.`;

                return sendPushNotificationsToUser(member.uid, memberBody, {
                  childId: event.childId,
                  eventId: eventId,
                  screen: "PrimarySchedule",
                });
              })
            );
            memberResults.forEach((result) => {
              if (result.status === "rejected") {
                logger.error(
                  `Error sending notification to care team member:`,
                  result.reason,
                  eventId
                );
              }
            });
          }
        } catch (error) {
          logger.error(
            `Error processing care team notifications for event ${eventId}`,
            error
          );
        }

        // Finally, update the event.
        const nextNotificationTime = currentTime + 10 * 60 * 1000; // 10 minutes later
        try {
          await db
            .ref(`prescription_events/${childSnapshot.key}`)
            .update({ nextNotificationTime, notificationCount: 1 });
        } catch (updateError) {
          logger.error(
            `Error updating prescription event for child ${event.childId}:`,
            updateError
          );
        }
      })();

      promises.push(promise);
    }
  });

  await Promise.all(promises);
  return null;
};

export const processPrescriptionNextNotificationTime = async () => {
  const now = Date.now();
  const minuteStart = getStartOfMinute(now);
  const minuteEnd = getEndOfMinute(now);
  logger.log("🕑 now:", new Date(now).toISOString());
  // logger.log("🕑 now:", new Date(now).toISOString());

  const snap = await db
    .ref("prescription_events")
    .orderByChild("nextNotificationTime")
    .startAt(minuteStart)
    .endAt(minuteEnd)
    .once("value");

  const promises: Promise<any>[] = [];

  const totalEvents = snap.numChildren();
  if (totalEvents === 0) return;

  // 2) collect events into array
  // snap.forEach((childSnapshot) => {
  //   const event = childSnapshot.val();
  //   const eventId = childSnapshot.key;

  //   if (
  //     event.state === "active" &&
  //     event.nextNotificationTime &&
  //     event.notificationCount <= 5
  //   ) {
  //     const promise = (async () => {
  //       let child: any;
  //       let parent: any;
  //       let notificationBody = "";

  //       // 1) Get child data
  //       try {
  //         child = await getChild(event.childId);
  //         if (!child) {
  //           throw new Error(`Child not found for ID ${event.childId}`);
  //         }
  //       } catch (error) {
  //         logger.error(`Error fetching child for event ${eventId}:`, error);
  //       }

  //       // 2) Get parent data
  //       try {
  //         if (child) {
  //           parent = await getUser(child.parentId);
  //           if (!parent) {
  //             throw new Error(`Parent not found for ID ${child.parentId}`);
  //           }
  //         }
  //       } catch (error) {
  //         logger.error(`Error fetching parent for event ${eventId}:`, error);
  //       }

  //       // 3) fetch prescription
  //       const prescription = await getPrescription(event.prescriptionId);
  //       if (!prescription)
  //         throw new Error(`Prescription not found: ${event.prescriptionId}`);

  //       // 4) build notifications
  //       notificationBody = prescriptionNotification(
  //         child.childName,
  //         event.notificationCount,
  //         prescription.name
  //       );

  //       // 4) Send notification to parent if allowed
  //       try {
  //         if (parent && parent.allowsPushNotifications && notificationBody) {
  //           await sendPushNotificationsToUser(parent.uid, notificationBody, {
  //             childId: event.childId,
  //             eventId: eventId,
  //             screen: "PrimarySchedule",
  //           });
  //         }
  //       } catch (error) {
  //         logger.error(
  //           `Error sending notification to parent ${
  //             parent ? parent.uid : "unknown"
  //           } for event ${eventId}:`,
  //           error
  //         );
  //       }

  //       // 5) Send notifications to eligible care team members
  //       try {
  //         if (child) {
  //           const careFamilyMembers = await fetchCareFamilyMembers(
  //             child.parentId,
  //             event.childId
  //           );
  //           const eligibleMembers = careFamilyMembers.filter(
  //             (member) => member.allowsPushNotifications
  //           );
  //           const memberResults = await Promise.allSettled(
  //             eligibleMembers.map((member) =>
  //               sendPushNotificationsToUser(member.uid, notificationBody, {
  //                 childId: event.childId,
  //                 eventId: eventId,
  //                 screen: "PrimarySchedule",
  //               })
  //             )
  //           );
  //           memberResults.forEach((result) => {
  //             if (result.status === "rejected") {
  //               logger.error(
  //                 `Error sending notification to care team member for event ${eventId}:`,
  //                 result.reason
  //               );
  //             }
  //           });
  //         }
  //       } catch (error) {
  //         logger.error(
  //           `Error processing care team notifications for event ${eventId}:`,
  //           error
  //         );
  //       }

  //       // 6) update DB
  //       try {
  //         return await updatePrescriptionEventNotificationCount(
  //           event,
  //           eventId,
  //           now,
  //           prescription,
  //           parent.timeZone ?? "UTC"
  //         );
  //       } catch (updateError) {
  //         logger.error(
  //           `Error updating event ${eventId} in processPrescriptionNextNotificationTime:`,
  //           updateError
  //         );
  //       }

  //       logger.log(`✅ Updated event ${eventId}`);
  //     })();
  //     promises.push(promise);
  //   }
  // });

  snap.forEach((childSnapshot) => {
    const event = childSnapshot.val();
    const eventId = childSnapshot.key;

    // skip unqualified events
    if (
      event.state !== "active" ||
      !event.nextNotificationTime ||
      event.notificationCount > 5
    ) {
      return;
    }

    promises.push(
      (async () => {
        try {
          const child = await getChild(event.childId);
          if (!child)
            throw new Error(`Child not found for ID ${event.childId}`);

          const parent = await getUser(child.parentId);
          if (!parent)
            throw new Error(`Parent not found for ID ${child.parentId}`);

          const prescription = await getPrescription(event.prescriptionId);
          if (!prescription)
            throw new Error(`Prescription not found: ${event.prescriptionId}`);

          const parentLanguage = getPnLanguage(parent);
          const body = prescriptionNotification(
            child.childName,
            event.notificationCount,
            prescription.name,
            parentLanguage
          );

          if (parent.allowsPushNotifications) {
            await sendPushNotificationsToUser(parent.uid, body, {
              childId: event.childId,
              eventId,
              screen: "PrimarySchedule",
            });
          }

          const careFamilyMembers = await fetchCareFamilyMembers(
            child.parentId,
            event.childId
          );
          await Promise.allSettled(
            careFamilyMembers
              .filter((m) => m.allowsPushNotifications)
              .map((m) => {
                const memberLanguage = getPnLanguage({
                  pnLanguage: m.pnLanguage,
                });
                const memberBody = prescriptionNotification(
                  child.childName,
                  event.notificationCount,
                  prescription.name,
                  memberLanguage
                );
                return sendPushNotificationsToUser(m.uid, memberBody, {
                  childId: event.childId,
                  eventId,
                  screen: "PrimarySchedule",
                });
              })
          );

          await updatePrescriptionEventNotificationCount(
            event,
            eventId,
            now,
            prescription,
            parent.timeZone ?? "UTC"
          );

          logger.log(`✅ Updated event ${eventId}`);
        } catch (err) {
          logger.error(`❌ Failed event ${eventId}`, err);
        }
      })()
    );
  });

  if (promises.length === 0) {
    logger.log("No active events found this minute");
    return null;
  }

  await Promise.allSettled(promises);
  // logger.log(`✅ Completed ${promises.length} events`);

  // await Promise.all(promises);
  // return null;
};

type PnLanguage = "en" | "es";

const getPnLanguage = (user?: { pnLanguage?: string }): PnLanguage => {
  const lang =
    typeof user?.pnLanguage === "string"
      ? user.pnLanguage.toLowerCase()
      : "en";
  return lang === "es" ? "es" : "en";
};

const cycleTranslations: Record<PnLanguage, Record<string, string>> = {
  en: {
    acetaminophen: "Acetaminophen",
    ibuprofen: "Ibuprofen",
    alternating: "Alternating",
  },
  es: {
    acetaminophen: "Paracetamol",
    ibuprofen: "Ibuprofeno",
    alternating: "Alternar",
  },
};

const translateCycleName = (
  cycle: string,
  language: PnLanguage
): string => {
  const normalized = cycle?.toLowerCase?.() ?? "";
  return cycleTranslations[language]?.[normalized] ?? cycle ?? "";
};

function getNotificationMessage(
  child: any,
  event: any,
  language: PnLanguage = "en"
): string {
  const notificationCount = event.notificationCount;
  const cycle = translateCycleName(event.cycle, language);
  const childName = child.childName;

  if (language === "es") {
    switch (notificationCount) {
      case 1:
        return `Recordatorio 2: la dosis de ${cycle} de ${childName} está disponible.`;
      case 2:
        return `Recordatorio 3: la dosis de ${cycle} de ${childName} está disponible.`;
      case 3:
        return `Recordatorio 4: la dosis de ${cycle} de ${childName} está disponible.`;
      case 4:
        return `El episodio de ${cycle} de ${childName} está en pausa. Pulsa para continuar.`;
      default:
        return `${childName} puede recibir la siguiente dosis de ${cycle} ahora.`;
    }
  }

  switch (notificationCount) {
    case 1:
      return `2nd reminder: ${childName}'s ${cycle} dose is available.`;
    case 2:
      return `3rd reminder: ${childName}'s ${cycle} dose is available.`;
    case 3:
      return `4th reminder: ${childName}'s ${cycle} dose is available.`;
    case 4:
      return `${childName}'s ${cycle} episode is now paused. Tap to resume.`;
    default:
      return `${childName} can get the next ${cycle} dose now.`;
  }
}

function prescriptionNotification(
  childName: string,
  notificationCount: any,
  prescriptionName: any,
  language: PnLanguage = "en"
): string {
  const medName = capitalizeFirstLetter(prescriptionName);

  if (language === "es") {
    switch (notificationCount) {
      case 1:
        return `La dosis de ${medName} para ${childName} está pendiente. Pulsa para dar la dosis.`;
      case 2:
        return `La dosis de ${medName} para ${childName} está pendiente. Pulsa para dar la dosis.`;
      case 3:
        return `La dosis de ${medName} para ${childName} está pendiente. Pulsa para dar la dosis.`;
      case 4:
        return `Se omitió la dosis de ${medName} para ${childName}. Ingresa al programa para ver o editar.`;
      default:
        return `${childName} puede recibir la siguiente dosis de ${medName} ahora.`;
    }
  }

  switch (notificationCount) {
    case 1:
      return `${childName}'s ${medName} dose is due. Tap to give the dose.`;
    case 2:
      return `${childName}'s ${medName} dose is due. Tap to give the dose.`;
    case 3:
      return `${childName}'s ${medName} dose is due. Tap to give the dose.`;
    case 4:
      return `${childName}'s ${medName} dose was skipped. Head to the schedule to view or edit.`;
    default:
      return `${childName} can get the next ${medName} dose now.`;
  }
}

function updateEventNotificationCount(
  event: any,
  eventId: string,
  currentTime: number
) {
  let nextNotificationTime: number;
  // Calculate next notification time based on notification count and snoozeInterval
  switch (event.notificationCount) {
    case 1:
      nextNotificationTime =
        currentTime + (event.snoozeInterval || 10) * 60 * 1000;
      break;
    case 2:
      nextNotificationTime =
        currentTime + (event.snoozeInterval || 25) * 60 * 1000;
      break;
    case 3:
      nextNotificationTime =
        currentTime + (event.snoozeInterval || 15) * 60 * 1000;
      break;
    case 4:
      nextNotificationTime =
        currentTime + (event.snoozeInterval || 15) * 60 * 1000;
      break;
    default:
      // Normalize missing/unknown counts to first reminder timing
      event.notificationCount = 1;
      nextNotificationTime =
        currentTime + (event.snoozeInterval || 10) * 60 * 1000;
      break;
  }
  const newNotificationCount = event.notificationCount + 1;

  const updates =
    newNotificationCount === 5
      ? {
        state: "paused",
        nextNotificationTime: null,
        notificationCount: null,
        snoozeInterval: null,
      }
      : { nextNotificationTime, notificationCount: newNotificationCount };

  return db.ref(`events/${eventId}`).update(updates);
}

export async function updatePrescriptionEventNotificationCount(
  event: any,
  eventId: string,
  currentTime: number,
  prescription: any,
  timeZone: string
): Promise<void> {
  // --- 1) compute nextNotificationTime (same logic you had) ---
  let nextNotificationTime: number | undefined;
  switch (event.notificationCount) {
    case 1:
      nextNotificationTime =
        currentTime + (event.snoozeInterval || 10) * 60 * 1000;
      break;
    case 2:
      nextNotificationTime =
        currentTime + (event.snoozeInterval || 25) * 60 * 1000;
      break;
    case 3:
      nextNotificationTime =
        currentTime + (event.snoozeInterval || 15) * 60 * 1000;
      break;
    case 4:
      nextNotificationTime =
        currentTime + (event.snoozeInterval || 15) * 60 * 1000;
      break;
    default:
      // Normalize missing/unknown counts to first reminder timing
      event.notificationCount = 1;
      nextNotificationTime =
        currentTime + (event.snoozeInterval || 10) * 60 * 1000;
      break;
  }

  const newNotificationCount = (Number(event.notificationCount) || 0) + 1;

  // --- 2) Build one multipath 'updates' object ---
  const updates: Record<string, unknown> = {};
  const eventBase = `prescription_events/${eventId}`;

  if (newNotificationCount === 5) {
    // terminal: clear scheduling fields on the event
    updates[`${eventBase}/nextNotificationTime`] = null;
    updates[`${eventBase}/notificationCount`] = null;
    updates[`${eventBase}/snoozeInterval`] = null;

    // create the dose *in the same update* (no push().set round-trip)
    const doseRef = db.ref("prescription_doses").push();
    const doseId = doseRef.key as string;

    const dose = {
      id: doseId,
      prescriptionEventId: eventId,
      date: event.nextScheduledDose,
      given: false,
      frequencyType: prescription.frequency,
      name: prescription.name,
      dose: prescription.dose,
    };
    updates[`prescription_doses/${doseId}`] = dose;

    // compute and write the next cycle’s scheduled dose
    const timeStamp = calculateNextDose(prescription, timeZone);
    updates[`${eventBase}/nextScheduledDose`] = timeStamp;
  } else {
    // non-terminal: bump count + set nextNotificationTime
    if (typeof nextNotificationTime === "number") {
      updates[`${eventBase}/nextNotificationTime`] = nextNotificationTime;
    }
    updates[`${eventBase}/notificationCount`] = newNotificationCount;
  }

  // --- 3) One atomic write for everything above ---
  // logger.log(`💾 Updating event ${eventId} (multi-path)`);
  await db.ref().update(updates);
  // logger.log(`✅ Event ${eventId} updated (count → ${newNotificationCount})`);
}

const fetchCareFamilyMembers = async (parentId: string, childId: string) => {
  try {
    const { default: pLimit } = await import("p-limit");
    const userLimit = pLimit(5); // cap concurrent user fetches

    const careFamilySnapshot = await db
      .ref("caregiver")
      .orderByChild("parent_id")
      .equalTo(parentId)
      .once("value");

    const caregivers: Array<{ caregiver_id: string; children?: string[] }> = [];
    careFamilySnapshot.forEach((snap) => {
      const v = snap.val();
      caregivers.push(v);
    });

    const relevant = caregivers.filter(
      (m) => Array.isArray(m.children) && m.children.includes(childId)
    );

    const userReads = await Promise.all(
      relevant.map((cg) =>
        userLimit(async () => {
          const uSnap = await db.ref(`users/${cg.caregiver_id}`).once("value");
          if (!uSnap.exists()) return null;
          const uVal = uSnap.val() || {};
          if (!uVal.allowsPushNotifications) return null;
          return {
            uid: uSnap.key as string,
            allowsPushNotifications: true,
            pnLanguage: getPnLanguage(uVal),
          };
        })
      )
    );

    return userReads.filter(Boolean) as Array<{
      uid: string;
      allowsPushNotifications: true;
      pnLanguage?: PnLanguage;
    }>;
  } catch (error) {
    logger.error("Error fetching care family members:", error);
    return [];
  }
};

function getChild(childId) {
  return !childId
    ? Promise.reject(
      new Error(
        `Cannot locate child. An invalid childId was given - childId was undefined.`
      )
    )
    : db
      .ref(`/children/${childId}`)
      .once("value")
      .then((userSnapshot) => {
        return userSnapshot.exists()
          ? Object.assign({}, userSnapshot.val(), { id: userSnapshot.key })
          : undefined;
      });
}

function getUser(userId) {
  return !userId
    ? Promise.reject(
      new Error(
        `Cannot locate user. An invalid userId was given - userId was undefined.`
      )
    )
    : db
      .ref(`/users/${userId}`)
      .once("value")
      .then((userSnapshot) => {
        return userSnapshot.exists()
          ? Object.assign({}, userSnapshot.val(), { id: userSnapshot.key })
          : undefined;
      });
}

async function sendPushNotificationsToUser(
  userId: string,
  payload: string,
  data?: any
) {
  const pushTokensRef = db.ref(`/users/${userId}/pushToken`);
  try {
    const snapshot = await pushTokensRef.once("value");
    if (!snapshot.exists()) {
      logger.log(
        `No push token found for user ${userId}. Cannot send notification.`
      );
      return `No push token found for user ${userId}. Cannot send notification.`;
    }

    const recipientPushToken = snapshot.val();
    const threadId = data?.eventId;

    const androidConfig: admin.messaging.AndroidConfig = {
      priority: "high",
      collapseKey: threadId || "default",
    };

    const iosConfig: admin.messaging.ApnsConfig = {
      headers: { "apns-priority": "10" },
      payload: {
        aps: {
          sound: "default",
          "content-available": 1,
          "thread-id": threadId || "default",
        },
      },
    };

    // Convert data values to strings and skip null/undefined values

    const stringData: Record<string, string> = {};
    if (data) {
      Object.keys(data).forEach((key) => {
        const value = data[key];
        if (value !== null && value !== undefined) {
          stringData[key] = String(value);
        }
      });
    }

    const message: admin.messaging.Message = {
      token: recipientPushToken,
      notification: {
        title: "Encurage",
        body: payload,
      },
      data: stringData,
      android: androidConfig,
      apns: iosConfig,
    };

    const response = await admin.messaging().send(message);
    // logger.log(`Successfully sent message:`, response);
    return response;
  } catch (error) {
    if (
      error.errorInfo?.code === "messaging/registration-token-not-registered"
    ) {
      logger.error(`Token not registered for user ${userId}. Removing token.`);
      await pushTokensRef.remove();
    }
    logger.error(`Error sending push notification for user ${userId}`, error);
    throw error;
  }
}

const getPrescription = async (prescriptionId: string) => {
  try {
    const snapshot = await db
      .ref(`prescription/${prescriptionId}`)
      .once("value");
    const prescription = snapshot.val();
    if (!prescription) {
      throw new Error(`Prescription not found for ID ${prescriptionId}`);
    }
    return prescription;
  } catch (error) {
    logger.error(
      `Error fetching prescription for ID ${prescriptionId}:`,
      error
    );
    throw error;
  }
};

const getStartOfMinute = (epochTime: number): number => {
  return epochTime - (epochTime % 60000);
};

const getEndOfMinute = (epochTime: number): number => {
  const startOfMinute = getStartOfMinute(epochTime);
  return startOfMinute + 59999; // End of the current minute (one millisecond before the next minute)
};

const capitalizeFirstLetter = (str: string): string => {
  return str?.charAt(0)?.toUpperCase() + str?.slice(1);
};

const getCareFamilyName = async (parentId: string): Promise<string> => {
  try {
    const existingCaregiverSnapshot = await db
      .ref("caregiver")
      .orderByChild("parent_id")
      .equalTo(parentId)
      .once("value");

    if (existingCaregiverSnapshot.exists()) {
      const caregivers = existingCaregiverSnapshot.val();
      // If there is at least one caregiver with `familyName`, use it as the careFamily name
      const caregiverWithFamily: any = Object.values(caregivers).find(
        (caregiver: any) => caregiver.familyName
      );
      return caregiverWithFamily?.familyName || "Our Care Family";
    }
    return "Our Care Family"; // Default name if no familyName exists
  } catch (error) {
    logger.error("getCareFamilyName Error", error);
    throw new v1.https.HttpsError(
      "internal",
      "Unable to retrieve family name."
    );
  }
};

const removeAllCaregiversForUser = async (userId) => {
  try {
    const caregiverRef = db.ref("caregiver");

    // Query caregivers associated with the user ID (parent ID)
    const caregiverSnapshot = await caregiverRef
      .orderByChild("parent_id")
      .equalTo(userId)
      .once("value");

    if (!caregiverSnapshot.exists()) {
      logger.log(`No caregivers found for user: ${userId}`);
      return { message: "No caregivers to remove" };
    }

    const caregiverIds = Object.keys(caregiverSnapshot.val());

    // Remove all caregivers in parallel
    const removalPromises = caregiverIds.map((key) =>
      caregiverRef.child(key).remove()
    );

    await Promise.all(removalPromises);
    logger.log(`All caregivers removed for user: ${userId}`);
    return { message: "All caregivers removed successfully" };
  } catch (error) {
    logger.error(`Error removing caregivers for user ${userId}:`, error);
    throw new v1.https.HttpsError(
      "internal",
      "Failed to remove caregivers for the user."
    );
  }
};

export function calculateNextDose(prescription: any, timeZone: string): number {
  const { frequency, startDate, reminderTimes } = prescription || {};
  const currentTime = moment.tz(timeZone).valueOf();

  logger.log("calculateNextDose prescription", prescription, timeZone);
  logger.log("calculateNextDose currentTime", currentTime);

  // Safety: cap iterations to avoid infinite loops
  // let hops = 0;
  // const MAX_HOPS = 5;

  // Ensure nextDose is at least `startDate` and after the current time
  let nextDose = Math.max(startDate, currentTime);

  switch (frequency?.type) {
    case FrequencyInterval.HOURLY: {
      const intervalHrs = Number(frequency.interval);
      if (!intervalHrs || intervalHrs < 1 || intervalHrs > 12) {
        throw new Error("For HOURLY, interval (1-12) is required.");
      }
      // Anchor at the schedule’s intended start instant (epoch ms).
      // Prefer frequency.startDate if provided; otherwise use prescription.startDate.
      const anchorMs = Number(frequency.startDate ?? startDate);
      const intervalMs = intervalHrs * 60 * 60 * 1000;

      // If we haven't reached the anchor yet, first dose is exactly at anchor.
      if (currentTime <= anchorMs) {
        nextDose = anchorMs;
      } else {
        // Jump directly to the first occurrence strictly after "now".
        const elapsed = currentTime - anchorMs;
        const steps = Math.ceil(elapsed / intervalMs);
        nextDose = anchorMs + steps * intervalMs;
      }
      break;
    }
    case FrequencyInterval.DAILY: {
      const tz = prescription.timeZone || timeZone || "UTC";
      const countPerDay = Number(frequency?.interval);
      if (
        !countPerDay ||
        !Array.isArray(reminderTimes) ||
        reminderTimes.length === 0
      ) {
        throw new Error(
          "Frequency interval and reminderTimes are required for DAILY type."
        );
      }

      const sortedTimes = reminderTimes
        .filter((t: number) => Number.isFinite(t))
        .map((t: number) => Math.max(0, Math.min(t, 24 * 60 * 60 * 1000 - 1)))
        .sort((a: number, b: number) => a - b);

      const dayTimes = sortedTimes.slice(0, countPerDay);
      if (dayTimes.length === 0) {
        throw new Error("DAILY requires at least one valid reminder time.");
      }

      const nowZ = moment.tz(currentTime, tz);
      const startZ = moment.tz(Number(startDate), tz);
      const ref = nowZ.isAfter(startZ) ? nowZ : startZ;
      const dayStart = ref.clone().startOf("day");
      // try today
      for (const t of dayTimes) {
        const h = Math.floor(t / 3600000);
        const m = Math.floor((t % 3600000) / 60000);
        const candidate = dayStart
          .clone()
          .hour(h)
          .minute(m)
          .second(0)
          .millisecond(0);
        if (candidate.isAfter(ref)) {
          if (
            typeof prescription.endDate === "number" &&
            candidate.valueOf() > prescription.endDate
          ) {
            throw new Error(
              "No next dose: next occurrence would be after end date."
            );
          }
          nextDose = candidate.valueOf();
          break;
        }
      }
      // if we didn’t set nextDose from today, schedule the first time tomorrow
      if (nextDose <= currentTime) {
        const first = dayTimes[0];
        const fh = Math.floor(first / 3600000);
        const fm = Math.floor((first % 3600000) / 60000);
        const nextDayCandidate = dayStart
          .clone()
          .add(1, "day")
          .hour(fh)
          .minute(fm)
          .second(0)
          .millisecond(0);

        if (
          typeof prescription.endDate === "number" &&
          nextDayCandidate.valueOf() > prescription.endDate
        ) {
          throw new Error(
            "No next dose: next occurrence would be after end date."
          );
        }

        nextDose = nextDayCandidate.valueOf();
      }
      break;
    }
    case FrequencyInterval.WEEKLY: {
      const tz = prescription.timeZone || timeZone || "UTC";

      const weeksInterval = Number(frequency?.interval);
      if (!weeksInterval || weeksInterval < 1) {
        throw new Error("WEEKLY requires a positive interval (weeks).");
      }
      if (!Array.isArray(reminderTimes) || reminderTimes.length !== 1) {
        throw new Error(
          "WEEKLY requires exactly one reminderTime (ms since local midnight)."
        );
      }

      // Convert reminderTime (ms since local midnight) → H/M
      const rt = Math.max(
        0,
        Math.min(reminderTimes[0], 24 * 60 * 60 * 1000 - 1)
      );
      const hh = Math.floor(rt / 3_600_000);
      const mm = Math.floor((rt % 3_600_000) / 60_000);

      const nowZ = moment.tz(currentTime, tz);
      const startZ = moment.tz(Number(startDate), tz);
      const ref = nowZ.isAfter(startZ) ? nowZ : startZ;

      // Anchor cadence to the week that contains startDate
      const anchorWeekStart = startZ.clone().startOf("week"); // locale week (US: Sunday-start)
      const refWeekStart = ref.clone().startOf("week");

      // Weeks since anchor and alignment modulo
      const weeksSinceAnchor = refWeekStart.diff(anchorWeekStart, "weeks"); // integer
      const mod =
        ((weeksSinceAnchor % weeksInterval) + weeksInterval) % weeksInterval;

      // We always schedule on the same weekday as startDate
      const anchorWeekday = startZ.day(); // 0..6 (Sun..Sat)

      // Helper to build the candidate in a given aligned week index
      const buildCandidate = (weekIndexFromAnchor: number) =>
        anchorWeekStart
          .clone()
          .add(weekIndexFromAnchor, "weeks")
          .day(anchorWeekday)
          .hour(hh)
          .minute(mm)
          .second(0)
          .millisecond(0);

      // 1) If current week is an alignment week, try this week's occurrence
      if (mod === 0) {
        const candidate = buildCandidate(weeksSinceAnchor);
        if (candidate.isAfter(ref) && candidate.isSameOrAfter(startZ)) {
          nextDose = candidate.valueOf();
          break;
        }
      }

      // 2) Otherwise jump to the next alignment week: add (interval - mod) weeks
      const weeksToAdd = mod === 0 ? weeksInterval : weeksInterval - mod;
      let nextIndex = weeksSinceAnchor + weeksToAdd;

      // Build the next aligned occurrence; if somehow before startZ (edge), push one block forward
      let candidate = buildCandidate(nextIndex);
      if (candidate.isBefore(startZ)) {
        nextIndex += weeksInterval;
        candidate = buildCandidate(nextIndex);
      }

      nextDose = candidate.valueOf();
      break;
    }
    case FrequencyInterval.CERTAIN_DAYS: {
      const tz = prescription.timeZone || timeZone || "UTC";

      const days = frequency?.daysOfWeek as number[] | undefined; // 0=Sun..6=Sat
      if (!Array.isArray(days) || days.length === 0) {
        throw new Error("Days of the week are required for CERTAIN_DAYS type.");
      }
      if (!Array.isArray(reminderTimes) || reminderTimes.length === 0) {
        throw new Error("Reminder times are required for CERTAIN_DAYS type.");
      }

      // normalize + sort weekdays
      const allowedDays = [...new Set(days)].sort((a, b) => a - b);

      // normalize reminderTimes (ms since local midnight) -> [ {ms,h,m} ], sorted by ms
      const times = reminderTimes
        .filter((t: number) => Number.isFinite(t))
        .map((t: number) => Math.max(0, Math.min(t, 86_399_999))) // clamp to day
        .sort((a: number, b: number) => a - b)
        .map((ms) => ({
          ms,
          h: Math.floor(ms / 3_600_000),
          m: Math.floor((ms % 3_600_000) / 60_000),
        }));

      const nowZ = moment.tz(currentTime, tz);
      const startZ = moment.tz(Number(startDate), tz);
      const ref = nowZ.isAfter(startZ) ? nowZ : startZ;

      const todayStart = ref.clone().startOf("day");

      let found = false;

      // Search today + next 6 days (at most 7 iterations)
      for (let d = 0; d < 7 && !found; d++) {
        const dayStart = todayStart.clone().add(d, "day");
        const weekday = dayStart.day(); // 0..6

        if (!allowedDays.includes(weekday)) continue;

        for (const { h, m } of times) {
          // set civil time; this is DST-safe
          const candidate = dayStart
            .clone()
            .hour(h)
            .minute(m)
            .second(0)
            .millisecond(0);
          if (candidate.isAfter(ref)) {
            if (
              typeof prescription.endDate === "number" &&
              candidate.valueOf() > prescription.endDate
            ) {
              throw new Error(
                "No next dose: next occurrence would be after end date."
              );
            }

            nextDose = candidate.valueOf();
            found = true;
            break;
          }
        }
      }

      if (!found) {
        // Extremely rare (e.g., all times today were before ref and the only allowed day is >7 days away,
        // which cannot happen). As a safe fallback, jump one week to the first allowed day/time.
        const firstDay = allowedDays[0];
        const firstTime = times[0];
        const fallback = todayStart
          .clone()
          .add(7, "days")
          .day(firstDay)
          .hour(firstTime.h)
          .minute(firstTime.m)
          .second(0)
          .millisecond(0);

        if (
          typeof prescription.endDate === "number" &&
          fallback.valueOf() > prescription.endDate
        ) {
          throw new Error(
            "No next dose: next occurrence would be after end date."
          );
        }

        nextDose = fallback.valueOf();
      }

      break;
    }
    case FrequencyInterval.MONTHLY: {
      const tz = prescription.timeZone || timeZone || "UTC";

      const monthsInterval = Number(frequency?.interval);
      if (!monthsInterval || monthsInterval < 1 || monthsInterval > 12) {
        throw new Error("MONTHLY requires interval between 1 and 12.");
      }
      if (!Array.isArray(reminderTimes) || reminderTimes.length !== 1) {
        throw new Error(
          "MONTHLY requires exactly one reminderTime (ms since local midnight)."
        );
      }

      // Convert reminderTime (ms since local midnight) → H/M
      const rt = Math.max(0, Math.min(reminderTimes[0], 86_399_999));
      const hh = Math.floor(rt / 3_600_000);
      const mm = Math.floor((rt % 3_600_000) / 60_000);

      const nowZ = moment.tz(currentTime, tz);
      const startZ = moment.tz(Number(startDate), tz);
      const ref = nowZ.isAfter(startZ) ? nowZ : startZ;

      // Anchor to the month containing startDate
      const anchorMonthStart = startZ.clone().startOf("month");
      const refMonthStart = ref.clone().startOf("month");

      // How many whole months since anchor?
      const monthsSinceAnchor = refMonthStart.diff(anchorMonthStart, "months"); // integer

      // alignment modulo (0 means this month is an aligned month)
      const mod =
        ((monthsSinceAnchor % monthsInterval) + monthsInterval) %
        monthsInterval;

      const anchorDay = startZ.date(); // 1..31

      const buildCandidate = (monthsFromAnchor: number) => {
        const base = anchorMonthStart.clone().add(monthsFromAnchor, "months");
        const dim = base.daysInMonth();
        const day = Math.min(anchorDay, dim); // clamp to last day if needed
        return base.date(day).hour(hh).minute(mm).second(0).millisecond(0);
      };

      let candidate: moment.Moment;

      // 1) If this month is aligned, try it first
      if (mod === 0) {
        candidate = buildCandidate(monthsSinceAnchor);
        if (candidate.isAfter(ref) && candidate.isSameOrAfter(startZ)) {
          const v = candidate.valueOf();
          if (
            typeof prescription.endDate === "number" &&
            v > prescription.endDate
          ) {
            throw new Error(
              "No next dose: next occurrence would be after end date."
            );
          }
          nextDose = v;
          break;
        }
      }

      // 2) Otherwise jump to next aligned month (or from aligned month if today’s time has passed)
      const monthsToAdd = mod === 0 ? monthsInterval : monthsInterval - mod;
      candidate = buildCandidate(monthsSinceAnchor + monthsToAdd);

      // Guard against startZ being later than computed slot (rare): push another interval
      if (candidate.isBefore(startZ)) {
        candidate = buildCandidate(
          monthsSinceAnchor + monthsToAdd + monthsInterval
        );
      }

      const v = candidate.valueOf();
      if (
        typeof prescription.endDate === "number" &&
        v > prescription.endDate
      ) {
        throw new Error(
          "No next dose: next occurrence would be after end date."
        );
      }
      nextDose = v;
      break;
    }
    case FrequencyInterval.EVERY_OTHER_DAY: {
      const tz = prescription.timeZone || timeZone || "UTC";

      if (!Array.isArray(reminderTimes) || reminderTimes.length !== 1) {
        throw new Error(
          "EVERY_OTHER_DAY requires exactly one reminderTime (ms since local midnight)."
        );
      }

      // Convert reminderTime (ms since local midnight) → H/M (civil time)
      const rt = Math.max(0, Math.min(reminderTimes[0], 86_399_999));
      const hh = Math.floor(rt / 3_600_000);
      const mm = Math.floor((rt % 3_600_000) / 60_000);

      const nowZ = moment.tz(currentTime, tz);
      const startZ = moment.tz(Number(startDate), tz);
      const ref = nowZ.isAfter(startZ) ? nowZ : startZ;

      // Anchor: the day that contains startDate in schedule TZ
      const anchorDayStart = startZ.clone().startOf("day");
      const refDayStart = ref.clone().startOf("day");

      // How many whole days since the anchor day?
      const daysSinceAnchor = refDayStart.diff(anchorDayStart, "days"); // integer
      const mod = ((daysSinceAnchor % 2) + 2) % 2; // 0 if today is an aligned day, 1 if not

      const buildCandidate = (dayStart: moment.Moment) =>
        dayStart.clone().hour(hh).minute(mm).second(0).millisecond(0);

      let candidate: moment.Moment;

      if (mod === 0) {
        // Today is an aligned day — try today's time
        candidate = buildCandidate(refDayStart);
        if (!candidate.isAfter(ref)) {
          // Today's time already passed → jump two days to keep the even/odd pattern
          candidate = buildCandidate(refDayStart.clone().add(2, "days"));
        }
      } else {
        // Not an aligned day — next aligned day is tomorrow (1 day ahead)
        candidate = buildCandidate(refDayStart.clone().add(1, "day"));
      }

      // Optional endDate guard
      const v = candidate.valueOf();
      if (
        typeof prescription.endDate === "number" &&
        v > prescription.endDate
      ) {
        throw new Error(
          "No next dose: next occurrence would be after end date."
        );
      }

      nextDose = v;
      break;
    }
    case FrequencyInterval.ONCE_A_WEEKLY: {
      const tz = prescription.timeZone || timeZone || "UTC";

      if (!Array.isArray(reminderTimes) || reminderTimes.length !== 1) {
        throw new Error(
          "ONCE_A_WEEKLY requires exactly one reminderTime (ms since local midnight)."
        );
      }

      // convert reminderTime (ms since local midnight) → H/M
      const rt = Math.max(
        0,
        Math.min(reminderTimes[0], 24 * 60 * 60 * 1000 - 1)
      );
      const hh = Math.floor(rt / 3_600_000);
      const mm = Math.floor((rt % 3_600_000) / 60_000);

      const nowZ = moment.tz(currentTime, tz);
      const startZ = moment.tz(Number(startDate), tz);
      const ref = nowZ.isAfter(startZ) ? nowZ : startZ;

      // Anchor cadence to the week containing startDate (US locale week = Sunday start).
      // If you want ISO weeks (Mon start), use 'isoWeek' and 'isoWeekday'.
      const anchorWeekStart = startZ.clone().startOf("week");
      const refWeekStart = ref.clone().startOf("week");

      // Weeks since anchor and the same weekday as startDate
      const weeksSinceAnchor = refWeekStart.diff(anchorWeekStart, "weeks"); // integer
      const anchorWeekday = startZ.day(); // 0..6 (Sun..Sat)

      const buildCandidate = (weekIndexFromAnchor: number) =>
        anchorWeekStart
          .clone()
          .add(weekIndexFromAnchor, "weeks")
          .day(anchorWeekday)
          .hour(hh)
          .minute(mm)
          .second(0)
          .millisecond(0);

      // Try this week's occurrence (same weekday/time) if it's strictly after ref
      let candidate = buildCandidate(weeksSinceAnchor);
      if (candidate.isAfter(ref) && candidate.isSameOrAfter(startZ)) {
        if (
          typeof prescription.endDate === "number" &&
          candidate.valueOf() > prescription.endDate
        ) {
          throw new Error(
            "No next dose: next occurrence would be after end date."
          );
        }
        nextDose = candidate.valueOf();
        break;
      }

      // Otherwise, take the next week’s occurrence
      candidate = buildCandidate(weeksSinceAnchor + 1);
      if (candidate.isBefore(startZ)) {
        // extremely rare edge if startZ is later than that week’s occurrence—push one more week
        candidate = buildCandidate(weeksSinceAnchor + 2);
      }

      if (
        typeof prescription.endDate === "number" &&
        candidate.valueOf() > prescription.endDate
      ) {
        throw new Error(
          "No next dose: next occurrence would be after end date."
        );
      }
      nextDose = candidate.valueOf();
      break;
    }
    default:
      throw new Error("Unsupported frequency type.");
  }
  logger.log("calculateNextDose nextDose", nextDose);
  return nextDose;
}

// *********************************************** https ************************************************************

export const moveOrDeleteFolder = v1.https.onCall(async (data, context) => {
  const { folder, childID, moveTracks, collection, folderCollection } = data;
  const folderID = folder.id;
  let message = "";

  try {
    // Get all entries in the folder
    const tracksSnapshot = await db
      .ref(`${collection}/${childID}`)
      .orderByChild("folder/id")
      .equalTo(folderID)
      .once("value");

    const entries = tracksSnapshot.val();

    // If no entries are found, initialize entries as an empty object
    if (!entries) {
      logger.log(`No entries found in folder ${folderID}`);
    }

    if (moveTracks) {
      // Get the general folder ID
      const generalFolderSnapshot = await db
        .ref(`${folderCollection}/${childID}`)
        .orderByChild("name")
        .equalTo("general")
        .once("value");
      if (!generalFolderSnapshot.exists()) {
        throw new Error("General folder not found.");
      }

      const generalFolder = Object.values(generalFolderSnapshot.val())[0];

      // Move entries to the general folder only if entries exist
      if (entries) {
        const updates = {};
        Object.keys(entries).forEach((trackId) => {
          updates[`${collection}/${childID}/${trackId}/folder`] = generalFolder;
        });
        await db.ref().update(updates);
        message = "and entries moved to the general folder ";
      }
    } else {
      // Delete the entries only if entries exist
      if (entries) {
        const trackDeletePromises = Object.keys(entries).map((trackId) =>
          db.ref(`${collection}/${childID}/${trackId}`).remove()
        );
        await Promise.all(trackDeletePromises);
        message = "and entries deleted ";
      }
    }

    // Delete the folder after no entries
    await db.ref(`${folderCollection}/${childID}/${folderID}`).remove();

    return {
      message: `Folder deleted ${message}successfully`,
      code: "SUCCESS",
    };
  } catch (error) {
    logger.error("Error moving or deleting folder entries or folder:", error);
    logger.log("error", error);
    throw new v1.https.HttpsError("internal", error.message);
  }
});

export const deleteEntries = v1.https.onCall(async (data, context) => {
  const { folder, childID, collection } = data;
  const folderID = folder.id;
  try {
    // Get all entry in the folder
    const entriesSnapshot = await db
      .ref(`${collection}/${childID}`)
      .orderByChild("folder/id")
      .equalTo(folderID)
      .once("value");

    const entry = entriesSnapshot.val();

    // Delete the entry
    const trackDeletePromises = Object.keys(entry).map((trackId) =>
      db.ref(`${collection}/${childID}/${trackId}`).remove()
    );
    await Promise.all(trackDeletePromises);

    return {
      message: "All entries deleted successfully",
      code: "SUCCESS",
    };
  } catch (error) {
    logger.error("Error moving or deleting folder entry or folder:", error);
    throw new v1.https.HttpsError("internal", error.message);
  }
});

// Helper function to generate an 8-character alphanumeric code
function generateRandomCode(length: number = 8): string {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz023456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    code += characters[randomIndex];
  }
  return code;
}

// Callable function to create a caregiver invite in Realtime Database
export const generateCaregiverInviteCode = v1.https.onCall(
  async (data, context) => {
    const { parentId } = data;
    if (!parentId) {
      throw new v1.https.HttpsError(
        "invalid-argument",
        "The function must be called with a valid parentId."
      );
    }

    // Generate the 8-character code
    const code = generateRandomCode();

    // Calculate creation and expiration times (24 hours after creation)
    const creationTime = Date.now();
    const expirationTime = creationTime + 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    // Data to save to Realtime Database
    const inviteData = {
      parentId,
      code,
      creationTime,
      expirationTime,
    };

    // Save invite to Realtime Database under `caregiver_invite`
    try {
      const inviteRef = await db.ref("caregiver_invite").push(inviteData);
      return { success: true, inviteId: inviteRef.key, code };
    } catch (error) {
      logger.error("Error creating caregiver invite:", error);
      throw new v1.https.HttpsError(
        "internal",
        "Failed to create caregiver invite."
      );
    }
  }
);

export const verifyAndAddCaregiver = v1.https.onCall(async (data, context) => {
  const { code, caregiverId, caregiverName } = data;

  if (!code || !caregiverId) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "Code and caregiverId must be provided."
    );
  }

  // Step 1: Reference to caregiver_invite collection
  const caregiverInviteRef = db.ref("caregiver_invite"); //caregiver_invite

  try {
    // Query caregiver_invite collection by code
    const snapshot = await caregiverInviteRef
      .orderByChild("code")
      .equalTo(code)
      .once("value");

    if (!snapshot.exists()) {
      // If no match is found, return "invalid code"
      return { message: "invalid code" };
    }

    // Step 2: If the code is found, extract invite data
    const inviteKey = Object.keys(snapshot.val())[0]; // Get the key
    const inviteData = snapshot.val()[inviteKey];

    // Step 3: Check expiration
    const currentTime = Date.now();
    if (inviteData.expirationTime <= currentTime) {
      return { message: "code expired" };
    }

    // Step 4: Check if a caregiver with the given caregiverId and parentId already exists
    const existingCaregiverSnapshot = await db
      .ref("caregiver")
      .orderByChild("caregiver_id")
      .equalTo(caregiverId)
      .once("value");

    if (existingCaregiverSnapshot.exists()) {
      const caregivers = existingCaregiverSnapshot.val();
      for (const key in caregivers) {
        const caregiver = caregivers[key];
        if (caregiver.parent_id === inviteData.parentId) {
          // If caregiver with the same caregiverId and parentId exists, return a message
          return { message: "caregiver already exists" };
        }
      }
    }

    const familyName = await getCareFamilyName(inviteData.parentId);

    // Step 5: Code is valid, add caregiver entry
    const caregiverRef = db.ref("caregiver").push();
    await caregiverRef.set({
      caregiver_id: caregiverId,
      create_date: currentTime,
      guardian: false,
      parent_id: inviteData.parentId,
      id: caregiverRef.key,
      familyName,
    });

    //remove code

    await caregiverInviteRef.child(inviteKey).remove();

    // Send push notification to the parent

    await sendPushAfterInviteAccept(inviteData.parentId, caregiverName);

    return {
      message: "caregiver added successfully",
      caregiverId: caregiverRef.key,
    };
  } catch (error) {
    logger.error("Error verifying and adding caregiver:", error);
    throw new v1.https.HttpsError(
      "internal",
      "An error occurred while processing the request."
    );
  }
});

const sendPushAfterInviteAccept = async (parentId: string, userName) => {
  try {
    return getUser(parentId).then((parent) => {
      if (!parent) {
        throw new Error(`Parent not found for ID ${parentId}`);
      }
      const parentPushToken = parent?.pushToken;
      if (!parentPushToken) {
        logger.log(`No pushToken for parent with ID ${parent.uid}`);
      }

      const language = getPnLanguage(parent);
      const message =
        language === "es"
          ? `${userName} aceptó tu invitación, y se unió a la familia encargada. Puedes completar la configuración en la pestaña de Familia Encargada.`
          : `${userName} has accepted your invitation, and joined the care family. You can now complete the setup in the Care Family tab.`;

      return sendPushNotificationsToUser(
        parent.uid,
        message,
        { screen: "Caregivers" }
      )
        .then(() => { })
        .catch((error) => {
          logger.error(
            "Error sending care family invitation Push Notification",
            error
          );
        });
    });
  } catch (error) {
    logger.error(
      "Error sending care family invitation Push Notification",
      error
    );
  }
};

export const updateCareFamilyName = v1.https.onCall(async (data, context) => {
  const { parentId, familyName } = data;

  if (!parentId || !familyName) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "Parent ID and family name must be provided."
    );
  }

  try {
    // Step 1: Retrieve caregivers with the matching parentId
    const caregiversSnapshot = await db
      .ref("caregiver")
      .orderByChild("parent_id")
      .equalTo(parentId)
      .once("value");

    if (!caregiversSnapshot.exists()) {
      return { message: "No caregivers found with the given parent ID." };
    }

    // Step 2: Prepare updates for each caregiver
    const updates: Record<string, any> = {};
    caregiversSnapshot.forEach((snapshot) => {
      const caregiverKey = snapshot.key;

      // Update familyName if it exists, or add it if not present
      updates[`caregiver/${caregiverKey}/familyName`] = familyName;
    });

    // Step 3: Apply the updates to the database
    await db.ref().update(updates);

    return {
      message: "Family name updated successfully for all caregivers.",
      code: "SUCCESS",
    };
  } catch (error) {
    logger.error("Error updating care family name:", error);
    throw new v1.https.HttpsError(
      "internal",
      "An error occurred while updating the care family name."
    );
  }
});

export const addPrescriptionAndEvent = v1.https.onCall(
  async (data, context) => {
    const { prescription, pastDoses, nextScheduledDose } = data;

    if (!prescription || !prescription.childId || !prescription.parentId) {
      throw new v1.https.HttpsError(
        "invalid-argument",
        "Prescription data must include childId and parentId."
      );
    }

    try {
      // Step 1: Add the prescription
      const prescriptionRef = db.ref("prescription").push();
      const prescriptionId = prescriptionRef.key;

      if (!prescriptionId) {
        throw new v1.https.HttpsError(
          "internal",
          "Failed to generate a prescription ID."
        );
      }

      const prescriptionWithId = {
        ...prescription,
        id: prescriptionId,
      };

      // Save prescription
      const savePrescription = prescriptionRef.set(prescriptionWithId);

      // Step 2: Add the prescription event
      const prescriptionEventsRef = db.ref("prescription_events").push();
      const prescriptionEventId = prescriptionEventsRef.key;

      if (!prescriptionEventId) {
        throw new v1.https.HttpsError(
          "internal",
          "Failed to generate a prescription event ID."
        );
      }

      const prescriptionEventData = {
        childId: prescription.childId,
        prescriptionId,
        createDate: prescription.dateAdded,
        startDate: prescription.startDate,
        state: "active",
        eventId: prescriptionEventId,
        nextScheduledDose: nextScheduledDose,
      };

      // Save prescription event
      const savePrescriptionEvent = prescriptionEventsRef.set(
        prescriptionEventData
      );

      // Step 3: Add individual doses to prescription_doses collection
      const dosesRef = db.ref("prescription_doses");
      const doseWrites: Promise<void>[] = (pastDoses || []).map(
        (dose: Dose) => {
          const doseRef = dosesRef.push();
          const doseData: Doses = {
            id: doseRef.key!,
            name: prescription.name,
            prescriptionEventId,
            date: dose.date,
            timeGiven: dose.date,
            given: true,
            dose: prescription.dose,
          };

          return doseRef.set(doseData);
        }
      );

      // Step 4: Increment eoasCount for the user
      const userRef = db.ref(`/users/${prescription.parentId}`);
      const incrementEoasCount = userRef.transaction((user) => {
        if (user) {
          user.eoasCount = (user.eoasCount || 0) + 1;
        }
        return user;
      });

      // Step 5: Wait for all writes to complete
      await Promise.all([
        savePrescription,
        savePrescriptionEvent,
        ...doseWrites,
        incrementEoasCount,
      ]);

      return {
        message: "Prescription, events, and doses added successfully",
        prescriptionId,
        prescriptionEventId,
        status: "OK",
      };
    } catch (error) {
      logger.error("Error adding prescription and events:", error);
      throw new v1.https.HttpsError(
        "internal",
        "An error occurred while processing the request."
      );
    }
  }
);
// ***************************************************** Start Subscription ********************************
// Define endpoints for receipt validation
const APPLE_RECEIPT_VALIDATION_URL =
  "https://buy.itunes.apple.com/verifyReceipt";
const APPLE_SANDBOX_URL = "https://sandbox.itunes.apple.com/verifyReceipt";

/**
 * Validates in-app purchase receipts for Apple and Google Play.
 * @param {Object} data - Request data from the client.
 * @returns {Promise<Object>} Validation result.
 */
exports.validatePurchase = v1.https.onCall(async (data, context) => {
  const { platform, receipt, packageName, productId } = data;

  // Ensure the user is authenticated
  if (!context.auth) {
    throw new v1.https.HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const userId = context.auth.uid; // Extract the authenticated user's UID

  if (!platform || !receipt) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "The function must be called with a platform and receipt."
    );
  }

  try {
    let validationResponse;
    const now = Date.now();

    logger.log("Validating purchase:", {
      platform,
      receipt,
      packageName,
      productId,
    });

    if (platform === "ios") {
      // Apple Receipt Validation
      validationResponse = await validateAppleReceipt(receipt);
      if (validationResponse.status !== 0) {
        throw new Error("Invalid Apple receipt.");
      }

      // Parse the `latest_receipt_info`
      const latestReceiptInfo = validationResponse.latest_receipt_info || [];

      // Find the most recent valid subscription
      const activeSubscription = latestReceiptInfo.find((info) => {
        return parseInt(info.expires_date_ms, 10) > now;
      });

      const subscriptionExpiry = activeSubscription
        ? new Date(parseInt(activeSubscription.expires_date_ms, 10))
        : null;

      // Update subscription status in the database
      await db.ref(`/users/${userId}`).update({
        purchaseInfo: {
          subscriptionExpiry: subscriptionExpiry?.toISOString() || null,
          productId,
          transactionReceipt: receipt, // For Apple
        },
        subscribed: !!activeSubscription, // true if an active subscription exists
      });

      logger.log("validationResponse", validationResponse);
      logger.log("validationResponse.status", validationResponse.status);

      return {
        status: validationResponse.status, // Apple status
        latestReceiptInfo: validationResponse.latest_receipt_info[0], // Pass other info if needed
        subscriptionStatus: !!activeSubscription,
      };
    } else if (platform === "android") {
      // Google Play Receipt Validation
      const parsedReceipt =
        typeof receipt === "string" ? JSON.parse(receipt) : receipt;
      const purchaseToken = parsedReceipt.purchaseToken;

      validationResponse = await validateGoogleReceipt(
        purchaseToken,
        packageName,
        productId
      );

      logger.log("Google Validation Response:", validationResponse);

      // if (!validationResponse || validationResponse.purchaseState !== 0) {
      //   throw new Error("Invalid Google Play receipt.");
      // }

      const subscriptionExpiry = new Date(
        parseInt(validationResponse.expiryTimeMillis, 10)
      );

      await db.ref(`/users/${userId}`).update({
        purchaseInfo: {
          subscriptionExpiry: subscriptionExpiry.toISOString(),
          productId,
          purchaseToken: purchaseToken, // For Google
        },
        subscribed: subscriptionExpiry.getTime() > now,
      });

      return {
        purchaseState: validationResponse.paymentState, // Google purchase state
        orderId: validationResponse.orderId, // Additional info if needed
        subscriptionStatus: subscriptionExpiry.getTime() > now,
      };
    } else {
      throw new v1.https.HttpsError(
        "invalid-argument",
        "Invalid platform specified."
      );
      return {
        success: false,
      };
    }
  } catch (error) {
    logger.error("Error validating purchase:", error);
    throw new v1.https.HttpsError("internal", "Purchase validation failed.");
  }
});

exports.checkSubscription = v1.https.onCall(async (_, context) => {
  logger.log("data", _);

  // Ensure the user is authenticated
  if (!context.auth) {
    logger.error("Unauthenticated request.");
    throw new v1.https.HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const userId = context.auth.uid; // Extract the authenticated user's UID
  logger.log(`Checking subscription for user: ${userId}`);

  try {
    const userRef = db.ref(`/users/${userId}`);
    const userSnapshot = await userRef.once("value");
    const userData = userSnapshot.val();

    if (userData?.legacySubscription === true) {
      return {
        subscribed: "legacySubscription",
        subscriptionExpiry: userData?.subscriptionExpiry,
      };
    }

    const now = Date.now();
    const purchaseInfo = userData?.purchaseInfo;

    // -------------------------------------------------
    // iOS EARLY RETURN: subscribed true + good cache
    // -------------------------------------------------
    if (
      userData?.subscribed === true && // user marked subscribed
      purchaseInfo?.transactionReceipt && // iOS path
      !purchaseInfo?.purchaseToken && // ensure not Android
      typeof purchaseInfo.subscriptionExpiry === "string"
    ) {
      const expiryMs = Date.parse(purchaseInfo.subscriptionExpiry);

      if (!Number.isNaN(expiryMs) && expiryMs > now) {
        logger.log(
          `Early-returning cached iOS subscription for user ${userId}. ` +
          `Expiry: ${purchaseInfo.subscriptionExpiry}`
        );

        return {
          subscribed: true,
          subscriptionExpiry: purchaseInfo.subscriptionExpiry,
        };
      }
    }

    if (
      !userData ||
      (!purchaseInfo?.transactionReceipt && !purchaseInfo?.purchaseToken)
    ) {
      logger.warn(
        `No subscription data found for user: ${userId}. Data: ${JSON.stringify(
          userData
        )}`
      );
    }

    logger.log(
      `User subscription data retrieved: ${JSON.stringify(purchaseInfo)}`
    );

    let validationResponse;
    let isSubscribed = false;
    let subscriptionExpiry = null;
    let updatedPurchaseInfo = purchaseInfo ? { ...purchaseInfo } : {};

    const applyGracePeriod = (expiryMillis, isAnnual) => {
      const gracePeriod = isAnnual
        ? 14 * 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
      return expiryMillis + gracePeriod > now;
    };

    // ------------------
    // APPLE (iOS) PATH
    // ------------------
    if (purchaseInfo?.transactionReceipt && !purchaseInfo?.purchaseToken) {
      logger.log("Validating with Apple...");

      validationResponse = await validateAppleReceipt(
        purchaseInfo.transactionReceipt
      );

      logger.log("Apple validation response:", validationResponse);

      if (
        validationResponse.status === 0 ||
        validationResponse.status === 21006
      ) {
        const latestReceiptInfo = validationResponse.latest_receipt_info || [];
        logger.log("Latest receipt info:", latestReceiptInfo);

        const activeSubscription = latestReceiptInfo.find(
          (info) => parseInt(info.expires_date_ms, 10) > now
        );
        logger.log("activeSubscription: ", activeSubscription);

        isSubscribed = !!activeSubscription;

        if (activeSubscription) {
          const expiryMillis = parseInt(activeSubscription.expires_date_ms, 10);
          const isAnnual = activeSubscription.product_id.includes("year");

          const isBillingIssue = activeSubscription.payment_state === 0;
          if (
            !isSubscribed &&
            isBillingIssue &&
            applyGracePeriod(expiryMillis, isAnnual)
          ) {
            isSubscribed = true;
          }

          subscriptionExpiry = new Date(expiryMillis).toISOString();

          // keep purchaseInfo in sync for future early returns
          updatedPurchaseInfo.subscriptionExpiry = subscriptionExpiry;
          updatedPurchaseInfo.transactionReceipt =
            validationResponse.latest_receipt;
        }
      } else {
        logger.warn(
          `Apple receipt validation failed with status: ${validationResponse.status}`
        );
      }
    }
    // ------------------
    // GOOGLE (ANDROID) PATH
    // ------------------
    else if (purchaseInfo?.purchaseToken) {
      logger.log("Validating with Google...");

      validationResponse = await validateGoogleReceipt(
        purchaseInfo.purchaseToken,
        "com.encurage",
        purchaseInfo.productId
      );

      logger.log("Google validation response:", validationResponse);

      if (validationResponse) {
        const expiryMillis = parseInt(validationResponse.expiryTimeMillis, 10);
        const isAnnual = validationResponse.priceAmountMicros > 5000000; // Adjust based on your pricing

        if (validationResponse.paymentState === 0) {
          // Billing issue: Apply grace period
          if (applyGracePeriod(expiryMillis, isAnnual)) {
            isSubscribed = true;
          }
        } else if (validationResponse.paymentState === 1) {
          // Payment received
          isSubscribed = expiryMillis > now;
        }

        subscriptionExpiry = isSubscribed
          ? new Date(expiryMillis).toISOString()
          : null;

        // If you want to track expiry for Android as well:
        if (subscriptionExpiry) {
          updatedPurchaseInfo.subscriptionExpiry = subscriptionExpiry;
        }

        // If you want to update purchaseToken when linkedPurchaseToken exists:
        // if (validationResponse.linkedPurchaseToken) {
        //   updatedPurchaseInfo.purchaseToken =
        //     validationResponse.linkedPurchaseToken;
        // }
      } else {
        logger.warn(
          `Google receipt validation failed with paymentState: ${validationResponse?.paymentState}`
        );
      }
    } else {
      logger.error("No valid receipt data found for validation.");
    }

    // Update the subscription status and purchaseInfo
    await userRef.update({
      subscribed: isSubscribed,
      purchaseInfo: updatedPurchaseInfo,
    });

    if (isSubscribed === false) {
      // Remove all caregivers associated with the user
      await removeAllCaregiversForUser(userId);
    }

    logger.log(
      `Subscription data updated for user ${userId}. Subscribed: ${isSubscribed}, Expiry: ${subscriptionExpiry}`
    );

    return {
      subscribed: isSubscribed,
      subscriptionExpiry,
    };
  } catch (error) {
    logger.error(`Error checking subscription for user ${userId}:`, error);
    throw new v1.https.HttpsError(
      "internal",
      "Failed to check subscription status."
    );
  }
});

/**
 * Validates an Apple receipt.
 * @param {string} receipt - Base64-encoded receipt.
 * @returns {Promise<Object>} Validation result.
 */
async function validateAppleReceipt(receipt) {
  const sharedSecret = v1.config().appstore.shared_secret;

  const body = {
    "receipt-data": receipt,
    password: sharedSecret, // Replace with your App Store shared secret
  };

  try {
    let response = await axios.post(APPLE_RECEIPT_VALIDATION_URL, body);
    // If the environment is sandbox, retry with the sandbox URL
    if (response.data.status === 21007) {
      response = await axios.post(APPLE_SANDBOX_URL, body);
    }
    return response.data;
  } catch (error) {
    logger.error("Apple receipt validation failed:", error);
    throw error;
  }
}

/**
 * Validates a Google Play receipt.
 * @param {string} purchaseToken - The purchase token from the client.
 * @param {string} packageName - The app package name.
 * @param {string} productId - The product ID of the subscription or in-app item.
 * @returns {Promise<Object>} Validation result.
 */
async function validateGoogleReceipt(purchaseToken, packageName, productId) {
  const auth = new google.auth.GoogleAuth({
    keyFile: "encurage-new-18b38f50569d.json",
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });

  try {
    const response = await google
      .androidpublisher("v3")
      .purchases.subscriptions.get({
        packageName: packageName,
        subscriptionId: productId,
        token: purchaseToken,
        auth: auth,
      });

    // Step 2: Check acknowledgment status
    if (response.data?.acknowledgementState === 0) {
      // Acknowledge the purchase if not already acknowledged
      const acknowledge = await google
        .androidpublisher("v3")
        .purchases.subscriptions.acknowledge({
          packageName: packageName,
          subscriptionId: productId,
          token: purchaseToken,
          auth: auth,
        });

      logger.log("acknowledge", acknowledge);
      logger.log(
        "Purchase acknowledged successfully for token:",
        purchaseToken
      );
    }
    logger.log("validateGoogleReceipt response", response);
    return response.data;
  } catch (error) {
    logger.error("Google receipt validation failed:", error);
    throw error;
  }
}

// ****************************************************** End Subscription ********************************

// ****************************************************** Start Data Migration ********************************

export const convertOnCureUser = onCall(
  {
    timeoutSeconds: 240,
    secrets: [ONCURE_SERVICE_ACCOUNT_JSON],
  },
  async (request: CallableRequest<any>) => {
    const data = request.data;

    const { appVersion, timeZone } = data;

    if (!request.auth) {
      throw new Error("Function must be called while authenticated.");
    }

    const userId = request.auth.uid;
    logger.log("userId", userId);

    // Guard: ensure onCureApp is initialized
    const onCureDb = admin.apps.some((app) => app.name === "onCureApp")
      ? admin.app("onCureApp").database()
      : null;

    if (!onCureDb) {
      logger.error("onCureApp is not initialized. Aborting convertOnCureUser.");
      throw new Error("Legacy user migration is not available.");
    }

    try {
      // 1) Fetch old user
      const userSnap = await onCureDb.ref(`/users/${userId}`).once("value");
      if (!userSnap.exists()) {
        throw new Error(`User ${userId} not found`);
      }
      const oldUserData = userSnap.val();

      // 2) Fetch children
      const childrenSnap = await onCureDb
        .ref("/children")
        .orderByChild("parent_id")
        .equalTo(userId)
        .once("value");

      const childrenData = (childrenSnap.val() || {}) as Record<
        string,
        ChildData
      >;
      const childIds = Object.keys(childrenData);

      // 3) Transform user
      const email = request.auth.token.email;
      const newUser = transformOnCureUser(
        oldUserData,
        userId,
        email,
        childIds,
        appVersion
      );

      // 4) Prepare big updates
      const updates: Record<string, any> = {};
      updates[`/users/${userId}`] = { ...newUser, converted: true };

      // 5) For each child, transform & migrate child + old symptoms
      for (const [childId, childObj] of Object.entries(childrenData)) {
        // A) Migrate child + symptoms
        const childUpdates = await transformAndMigrateChild(
          childObj,
          childId,
          appVersion
          // timeZone
        );
        Object.assign(updates, childUpdates);

        // B) Migrate old journals for this child
        const journalUpdates = await migrateJournalsForChild(childId);
        Object.assign(updates, journalUpdates);

        // C) Migrate prescriptions for this child
        const prescriptionUpdates = await migratePrescriptionsForChild(
          childId,
          timeZone
        );
        Object.assign(updates, prescriptionUpdates);
      }

      const caregiverUpdates = await migrateCaregiversForUser(userId);
      Object.assign(updates, caregiverUpdates);
      logger.log("caregiverUpdates", caregiverUpdates);
      // 6) Write all at once
      await db.ref().update(updates);

      return {
        message: "Success",
        user: newUser,
        childrenCount: childIds.length,
      };
    } catch (error: any) {
      logger.error("Error in convertOnCureUser:", error);
      throw new Error(error?.message || "Unknown error.");
    } finally {
      // Final step: update onCureDb to set allowsPushNotifications to false.
      try {
        await onCureDb
          .ref(`/users/${userId}/allowsPushNotifications`)
          .set(false);
        logger.log(
          `Set allowsPushNotifications to false for user ${userId} in onCureDb.`
        );
      } catch (err) {
        logger.error(
          `Error updating onCureDb allowsPushNotifications for user ${userId}:`,
          err
        );
        // Don't rethrow
      }
    }
  }
);

//************* User data ******************/

/**
 * Transform the old onCure user data into the new `User` shape.
 * - Copies all old fields by default.
 * - Renames specific keys as needed.
 * - Converts `dob` to epoch time.
 * - Adds `legacySubscription` if any legacy fields are present.
 * - Pulls `email` from the auth token (if available).
 */
function transformOnCureUser(
  oldData: any,
  userId: string,
  email: string | undefined,
  childrenIds: string[],
  appVersion: string | undefined
) {
  // 1) Start by shallow-copying all fields from the old data
  //    so we keep anything that doesn’t match the new model.
  const newUser: any = { ...oldData };

  // 2) Required fields in your new model
  newUser.uid = userId; // Must match the Auth user ID
  newUser.email = email ?? ""; // Might be empty if not found
  newUser.children = childrenIds; // The array of child IDs
  newUser.agreeToTerm = false; // Default false if not found
  newUser.authType = "email"; // Example default; customize as needed

  // 3) Handle renamed fields
  if (typeof newUser.first_name === "string") {
    newUser.firstName = newUser.first_name;
    delete newUser.first_name;
  }
  if (typeof newUser.last_name === "string") {
    newUser.lastName = newUser.last_name;
    delete newUser.last_name;
  }
  if (typeof newUser.apiVersion === "string") {
    newUser.appVersion = appVersion;
    delete newUser.apiVersion;
  }

  // 4) Convert `dob` to epoch time if it’s a string
  if (typeof newUser.dob === "string") {
    const dateObj = new Date(newUser.dob);
    if (!isNaN(dateObj.valueOf())) {
      newUser.dob = dateObj.getTime(); // milliseconds since epoch
    } else {
      newUser.dob = 0;
    }
  }

  // 5) Check for any legacy flags
  const legacyFlags = [
    "onCure360Enabled",
    "ongoingRxEnabled",
    "proMembershipEnabled",
    "symptomTrackerEnabled",
    "unlimitedEpisodesEnabled",
  ];
  for (const flag of legacyFlags) {
    if (newUser[flag]) {
      newUser.legacySubscription = true;
      break;
    }
  }

  // *** New Step: Remove push token ***
  // If a push token exists from the old app (which was from another project),
  // remove it so the client is forced to get a new token from the correct project.
  if (newUser.pushToken) {
    delete newUser.pushToken;
  }

  // *** New Step: Toggle allowsPushNotifications to false ***
  newUser.allowsPushNotifications = false;

  // 6) Return the final object.
  return newUser;
}

export async function migrateCaregiversForUser(
  userId: string
): Promise<Record<string, any>> {
  // 1) Gather all matching caregivers in one array
  const allCaregiversArray: Array<{ id: string;[k: string]: any }> = [];

  // A) Query for caregiver_id == userId
  const caregiverSnap = await onCureDb
    .ref("/caregiver")
    .orderByChild("caregiver_id")
    .equalTo(userId)
    .once("value");
  const caregiverVal = caregiverSnap.val() || {};
  logger.log("caregiverVal", caregiverVal);
  // Convert to array with key as 'id'
  for (const [key, val] of Object.entries(caregiverVal)) {
    allCaregiversArray.push({ id: key, ...(val as any) });
  }

  // B) Query for parent_id == userId
  const parentSnap = await onCureDb
    .ref("/caregiver")
    .orderByChild("parent_id")
    .equalTo(userId)
    .once("value");
  const parentVal = parentSnap.val() || {};
  for (const [key, val] of Object.entries(parentVal)) {
    allCaregiversArray.push({ id: key, ...(val as any) });
  }

  // 2) Build a multi-location updates object for new DB
  const multiLocUpdates: Record<string, any> = {};

  // 3) Filter out duplicates using the 'id' property
  const uniqueCaregiversMap = new Map<string, any>();
  for (const caregiver of allCaregiversArray) {
    uniqueCaregiversMap.set(caregiver.id, caregiver);
  }
  const uniqueCaregivers = Array.from(uniqueCaregiversMap.values());
  logger.log("uniqueCaregivers", uniqueCaregivers);

  // 4) For each caregiver record, transform as needed and store it
  for (const oldCaregiver of uniqueCaregivers) {
    const newCaregiverId = oldCaregiver.id;
    const newCaregiverObj = {
      ...oldCaregiver,
    };
    multiLocUpdates[`/caregiver/${newCaregiverId}`] = newCaregiverObj;
  }

  return multiLocUpdates;
}

//************* Child data ******************/
async function transformAndMigrateChild(
  oldChildData: any,
  childId: string,
  appVersion: string
): Promise<Record<string, any>> {
  // 1) Transform the child’s core data
  const newChild = transformOnCureChild(oldChildData, childId, appVersion); // your existing function

  // 2) Fetch old symptoms for this child
  const symptomSnap = await onCureDb
    .ref("/symptom")
    .orderByChild("child_id")
    .equalTo(childId)
    .once("value");
  const oldSymptomData = symptomSnap.val() || {};

  // 3) Get/create folder
  const folder = await getOrCreateGeneralFolder(childId);

  // 4) Build multi-loc updates
  const multiLocUpdates: Record<string, any> = {};

  // (a) The child itself
  // multiLocUpdates[`/children/${childId}`] = newChild;

  // (b) Group old symptoms by startDate
  const groupedMap = groupSymptomsByDate(oldSymptomData); // from step #1 above

  // (c) For each group => build one tracking doc with multiple symptoms
  for (const [epochTimeStr, symptomArray] of Object.entries(groupedMap)) {
    const epochTime = Number(epochTimeStr);

    // pick an ID from the first symptom
    const firstSym = symptomArray[0];
    const docId = firstSym.id || firstSym.symptomKey || db.ref().push().key;

    const newTracking: any = {
      id: docId,
      childId,
      trackingType: "symptoms",
      createdAt: epochTime, // or Date.now(), but typically we use the group's time
      data: {
        dateTime: epochTime,
        symptoms: {},
      },
      folder: {
        id: folder.id,
        name: folder.name,
        createdAt: folder.createdAt,
      },
    };

    // (d) For each oldSymptom in symptomArray => transform fields & add
    for (const oldSym of symptomArray) {
      const { newSymptomKey, symptomEntry } =
        transformSymptomFieldsOnly(oldSym);
      // put them in the doc
      symptomEntry.dateTime = epochTime; // set to group time if desired
      newTracking.data.symptoms[newSymptomKey] = symptomEntry;
    }

    // (e) store in multiLocUpdates
    const trackingPath = `/tracking/${childId}/${newTracking.id}`;
    multiLocUpdates[trackingPath] = newTracking;
  }

  // events  moment.tz(startDate, timeZone).valueOf(),
  const eventSnap = await onCureDb
    .ref("/events")
    .orderByChild("child_id")
    .equalTo(childId)
    .once("value");
  const allEvents = (eventSnap.val() || {}) as Record<string, any>;

  // 4) Find the single most recent event with state = active or paused
  let selectedEvent: any = null;
  let selectedEventKey: string | null = null;

  // 10 days in ms
  const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
  const cutoffTime = Date.now() - TEN_DAYS_MS;

  for (const [key, ev] of Object.entries(allEvents)) {
    // parse create_date
    const createMs = parseDate(ev.create_date); // a helper that converts string|number -> ms
    if (createMs < cutoffTime) {
      // If event is older than 10 days, ignore it entirely
      continue;
    }

    if (ev.state === "active" || ev.state === "paused") {
      selectedEvent = ev;
      selectedEventKey = key;
      break; // done (we only want the first match)
    }
  }

  // if we found one
  if (selectedEvent) {
    // 5) fetch doses for that event
    const dosesSnap = await onCureDb
      .ref("/doses")
      .orderByChild("event_id")
      .equalTo(selectedEventKey)
      .once("value");
    const doseData = dosesSnap.val() || {};

    // 6) transform the event + doses to your new format
    const newEventDoc = transformEventAndDoses(
      selectedEvent,
      selectedEventKey,
      doseData,
      newChild
    );

    // 7) store it in multiLocUpdates
    const eventPath = `/events/${newEventDoc.eventId}`;
    multiLocUpdates[eventPath] = newEventDoc;

    newChild.eventIds = [newEventDoc.eventId];
  }

  multiLocUpdates[`/children/${childId}`] = newChild;

  return multiLocUpdates;
}

/**
 * Transforms a single old child record into the new ChildDataType + preserves extra fields.
 * @param oldChildData - The original child object from onCureDb
 * @param childId - The key/ID in the old DB (must remain the same).
 */
function transformOnCureChild(
  oldChildData: any,
  childId: string,
  appVersion: string
): any {
  // 1. Start with a shallow copy so we keep any fields not in the new model
  const newChild: any = { ...oldChildData };

  // 2. Rename `full_name` -> `childName`
  if (typeof newChild.full_name === "string") {
    newChild.childName = newChild.full_name;
    delete newChild.full_name;
  }

  // 3. Rename `dob` -> `childBDay`, convert string to epoch time
  if (typeof newChild.dob === "string") {
    const dateObj = new Date(newChild.dob);
    newChild.childBDay = !isNaN(dateObj.valueOf()) ? dateObj.getTime() : 0;
    delete newChild.dob;
  }

  // 4. Rename `parent_id` -> `parentId`
  if (typeof newChild.parent_id === "string") {
    newChild.parentId = newChild.parent_id;
    delete newChild.parent_id;
  }

  // 5. Convert weight => weightUnitMajor (string) + set weightUnit if weight present
  if (typeof newChild.weight === "number") {
    newChild.weightUnitMajor = String(Math.floor(newChild.weight));
    newChild.weightUnit = "lbs";
    delete newChild.weight;
  }

  // 6. Build the `dosages` object conditionally
  const now = Date.now();

  // Check if the old fields exist (and are not undefined or null)
  const hasAcet = newChild?.user_defined_acetaminophen_dose != null;
  const hasIbu = newChild?.user_defined_ibuprofen_dose != null;

  if (hasAcet || hasIbu) {
    // Create a dosages object
    newChild.dosages = {};

    if (hasAcet) {
      // Convert the value; if missing, default to 0.
      const acetIndex = Number(newChild.user_defined_acetaminophen_dose);
      const finalAcetIndex = isNaN(acetIndex) ? 0 : acetIndex;
      const acetaminophenDoseValue = getAcetaminophenValue(finalAcetIndex);
      newChild.dosages.acetaminophen = {
        dateAdded: now,
        dose: acetaminophenDoseValue,
        maxDose: "5",
        name: "Acetaminophen",
        timeGap: "4",
      };
      if (acetaminophenDoseValue === "other") {
        const oldAcetText = newChild.user_defined_acetaminophen_dose_text;
        if (typeof oldAcetText === "string" && oldAcetText.trim() !== "") {
          newChild.dosages.acetaminophen.doseOther = oldAcetText;
        }
      }
    }

    if (hasIbu) {
      const ibuIndex = Number(newChild.user_defined_ibuprofen_dose);
      const finalIbuIndex = isNaN(ibuIndex) ? 0 : ibuIndex;
      const ibuprofenDoseValue = getIbuprofenValue(finalIbuIndex);
      newChild.dosages.ibuprofen = {
        dateAdded: now,
        dose: ibuprofenDoseValue,
        maxDose: "4",
        name: "Ibuprofen",
        timeGap: "6",
      };
      if (ibuprofenDoseValue === "other") {
        const oldIbuText = newChild.user_defined_ibuprofen_dose_text;
        if (typeof oldIbuText === "string" && oldIbuText.trim() !== "") {
          newChild.dosages.ibuprofen.doseOther = oldIbuText;
        }
      }
    }

    // Only add the alternating dosage if both acetaminophen and ibuprofen exist.
    if (hasAcet && hasIbu) {
      newChild.dosages.alternating = {
        dateAdded: now,
        name: "Alternating",
        timeGap: "3",
      };
    }
  }

  // Optionally, remove the old dosage fields if you don't need them anymore
  delete newChild.user_defined_acetaminophen_dose;
  delete newChild.user_defined_acetaminophen_dose_text;
  delete newChild.user_defined_ibuprofen_dose;
  delete newChild.user_defined_ibuprofen_dose_text;

  // 8. Retain the child's ID
  newChild.childId = childId;

  // 9. Add app version
  if (typeof newChild.apiVersion === "string") {
    newChild.appVersion = appVersion;
    delete newChild.apiVersion;
  }

  return newChild;
}

//************* Symptoms ******************/
function groupSymptomsByDate(
  oldSymptomData: Record<string, any>
): Record<number, any[]> {
  // We'll create a map of epochTime -> array of old symptom objects
  const grouped: Record<number, any[]> = {};

  for (const [symptomKey, symptomObj] of Object.entries(oldSymptomData)) {
    // Convert startDate to an epoch time (rounded, if needed)
    let epochTime = Date.now();
    if (typeof symptomObj.startDate === "string") {
      const d = new Date(symptomObj.startDate);
      if (!isNaN(d.valueOf())) {
        epochTime = d.getTime();
      }
    }
    // Add to the map
    if (!grouped[epochTime]) {
      grouped[epochTime] = [];
    }
    grouped[epochTime].push({ symptomKey, ...symptomObj });
  }

  return grouped;
}

function transformSymptomFieldsOnly(oldSymptom: any) {
  // 1) Determine the old symptomType, default to "custom"
  const oldType = oldSymptom.symptomType || "custom";

  // 2) Map to newSymptomKey
  const newSymptomKey = SYMPTOM_TYPE_MAP[oldType] || "other";

  // 3) parse notes, severity, etc.
  //    For grouping, we won't handle dateTime or createdAt here,
  //    because we want a single dateTime for the group doc.
  const symptomEntry: any = {
    symptomName: oldSymptom.customSymptomName || oldType,
  };

  // if severityScale is present
  if (oldSymptom.severityScale) {
    symptomEntry.severity = oldSymptom.severityScale;
  }

  // if notes is present
  if (oldSymptom.notes) {
    symptomEntry.notes = oldSymptom.notes;
  }

  // if oldType === 'fever'
  if (oldType === "fever" && typeof oldSymptom.temperature === "number") {
    const tempRounded = Math.round(oldSymptom.temperature * 10) / 10;
    symptomEntry.value = String(tempRounded);
    symptomEntry.degree = "f";
  }

  // optional leftover fields
  const handledKeys = new Set([
    "child_id",
    "id",
    "symptomType",
    "customSymptomName",
    "startDate",
    "notes",
    "severityScale",
    "apiVersion",
    "temperature",
  ]);
  for (const [key, value] of Object.entries(oldSymptom)) {
    if (!handledKeys.has(key)) {
      symptomEntry[key] = value;
    }
  }

  // Return just the key + partial object
  return { newSymptomKey, symptomEntry };
}

// For acetaminophen:
const acetaminophenDose = [
  { label: "1.25 mL infant’s suspension", value: "125ml" },
  { label: "2.5 mL infant’s suspension", value: "25ml" },
  { label: "3.75 mL infant’s suspension", value: "375ml" },
  {
    label: "5 mL children’s suspension - OR - 1 chewable tablet of 160 mg",
    value: "5ml",
  },
  {
    label: "7.5 mL children’s suspension - OR - 1.5 chewable tablets of 160mg",
    value: "75ml",
  },
  {
    label: "10 mL children’s suspension - OR - 2 chewable tablets of 160mg",
    value: "10ml",
  },
  {
    label: "12.5 mL children’s suspension - OR - 2.5 chewable tablets of 160mg",
    value: "125ml",
  },
  {
    label: "15 mL children’s suspension - OR - 3 chewable tablets of 160mg",
    value: "15ml",
  },
  {
    label:
      "20 mL children’s suspension - OR - 4 chewable tablets of 160mg each",
    value: "20ml",
  },
  { label: "Other", value: "other" },
];

// For ibuprofen:
const ibuprofenDose = [
  { label: "1.25 mL Infant Drops", value: "1.25ml" },
  { label: "1.875 mL Infant Drops", value: "1875ml" },
  {
    label: "5 mL Children's Suspension - OR - 1 chewable tablets of 100 mg",
    value: "5ml",
  },
  {
    label: "7.5 mL Children's Suspension - OR - 1.5 chewable tablets of 100 mg",
    value: "75ml",
  },
  {
    label: "10 mL Children's Suspension - OR - 2 chewable tablets of 100 mg",
    value: "10ml",
  },
  {
    label:
      "12.5 mL Children's Suspension - OR - 2.5 chewable tablets of 100 mg",
    value: "125ml",
  },
  {
    label: "15 mL Children's Suspension - OR - 3 chewable tablets of 100 mg",
    value: "15ml",
  },
  {
    label: "20 mL Children's Suspension - OR - 4 chewable tablets of 100 mg",
    value: "20ml",
  },
  { label: "Other", value: "other" },
];

/**
 * Returns the `value` string for the given acetaminophen dose index.
 * If out of range, defaults to 'other'.
 */
function getAcetaminophenValue(index: number): string {
  if (index >= 0 && index < acetaminophenDose.length) {
    return acetaminophenDose[index].value;
  }
  return "other"; // fallback
}

/**
 * Returns the `value` string for the given ibuprofen dose index.
 * If out of range, defaults to 'other'.
 */
function getIbuprofenValue(index: number): string {
  if (index >= 0 && index < ibuprofenDose.length) {
    return ibuprofenDose[index].value;
  }
  return "other"; // fallback
}

function getAcetaminophenLabel(value) {
  // Search the array for an item whose 'value' matches
  const item = acetaminophenDose.find((d) => d.value === value);
  // Return the label if found, otherwise undefined (or a fallback string)
  return item ? item.label : "Unknown";
}

function getIbuprofenLabel(value) {
  // Search the array for an item whose 'value' matches
  const item = ibuprofenDose.find((d) => d.value === value);
  // Return the label if found, otherwise undefined (or a fallback string)
  return item ? item.label : "Unknown";
}

/**
 * Gets or creates the "general" folder for a given child in the new DB.
 * @param childId The child's ID
 * @returns An object { id, name, createdAt }
 */
async function getOrCreateGeneralFolder(childId: string) {
  // 1) Reference to /folders/{childId}
  const folderRef = db.ref(`/folders/${childId}`);

  // 2) Fetch all folders
  const folderSnap = await folderRef.once("value");
  const folderData = folderSnap.val() || {};

  // 3) Try to find a folder whose name === 'general'
  for (const [folderId, folderObj] of Object.entries(folderData)) {
    if ((folderObj as any).name === "general") {
      // Found it, return existing
      return {
        id: folderId,
        name: "general",
        createdAt: (folderObj as any).createdAt || Date.now(),
      };
    }
  }

  // 4) If not found, create a new folder with push ID
  const newFolderRef = folderRef.push();
  const newFolderId = newFolderRef.key;
  const createdAt = Date.now();

  if (!newFolderId) {
    throw new Error("Failed to create new folder ID");
  }

  const newFolderObj = {
    id: newFolderId,
    name: "general",
    createdAt,
  };

  await newFolderRef.set(newFolderObj);

  return {
    id: newFolderId,
    name: "general",
    createdAt,
  };
}

const SYMPTOM_TYPE_MAP: Record<string, string> = {
  fever: "Temperature",
  cough: "Cough",
  congestion: "Congestion or Runny Nose",
  wheezing: "Wheezing",
  soreThroat: "Sore Throat",
  headache: "Headache",
  earAche: "Other", // no direct match in your new list, so "other"
  painfulUrination: "Other", // or maybe "frequentUrination"? If that's closer?
  constipation: "Constipation",
  diarrhea: "Diarrhea",
  vomiting: "Vomiting",
  rash: "Rash",
  spittingUp: "other", // no direct match
  pain: "Pain", // or "abdominalPain"? depends on your preferences
  stomachAche: "Other",
  fatigue: "Fatigue or Energy Loss",
  nausea: "Nausea",
  shortageOfBreath: "Shortage of Breath",
  eyeIssues: "Other", // maybe "dryEyes"? If it’s not perfect, you could do "other"
  // If there's "custom" or anything else not in this map → "other"
};

//************* Journal ******************/

async function migrateJournalsForChild(
  childId: string
): Promise<Record<string, any>> {
  // 1) Fetch old journal entries
  const snap = await onCureDb.ref(`/journals/${childId}/entries`).once("value");
  const oldEntries = snap.val() || {};
  const updates: Record<string, any> = {};

  // 2) Get or create the 'general' folder
  const folderObj = await getOrCreateGeneralFolder(childId);

  for (const [oldKey, oldEntry] of Object.entries(oldEntries)) {
    // 3) Build the new doc
    const newDoc = buildJournalDoc(childId, folderObj, oldEntry, oldKey);

    // 4) Decide your path: /tracking/{childId}/{docId}
    const docPath = `/journal/${childId}/${newDoc.id}`;
    updates[docPath] = newDoc;
  }

  return updates;
}

function buildJournalDoc(
  childId: string,
  folderObj: { id: string; name: string; createdAt: number },
  oldEntry: any,
  oldKey: string
) {
  // 1) transform core fields => data
  const journalData = transformJournalEntry(oldEntry);

  // 2) pick doc ID from old entry or push key
  const docId = oldKey || db.ref().push().key;

  let epochTime = Date.now();
  if (typeof oldEntry.date === "number") {
    // 978307200 is needed to adjust 31 years from ???
    epochTime = Math.round((oldEntry.date + 978307200) * 1000);
  }

  // 3) build final
  const newJournalDoc: any = {
    id: docId,
    childId,
    createdAt: epochTime,
    updatedAt: Date.now(),
    data: journalData,
    folder: {
      id: folderObj.id,
      name: folderObj.name,
      createdAt: folderObj.createdAt,
    },
  };

  return newJournalDoc;
}

function transformJournalEntry(oldEntry: any): any {
  // We'll build a "subjects" object
  const subjects: Record<string, any> = {};

  let epochTime = Date.now();
  if (typeof oldEntry.date === "number") {
    epochTime = Math.round((oldEntry.date + 978307200) * 1000);
  }

  if (oldEntry.appetite !== undefined) {
    subjects.appetite = {
      dateTime: epochTime,
      appetite: mapAppetite(oldEntry.appetite),
    };
  }

  if (oldEntry.energyLevels !== undefined) {
    subjects.energy = {
      dateTime: epochTime,
      energy: mapEnergyLevels(oldEntry.energyLevels),
    };
  }

  if (oldEntry.sleepDuration !== undefined) {
    subjects.sleep = {
      dateTime: epochTime,
      sleepLength: mapSleepDurationLevels(oldEntry.sleepDuration),
    };
  }

  if (oldEntry.sleepQuality !== undefined) {
    subjects.sleep.sleepQuality = mapSleepQualityLevels(oldEntry.sleepQuality);
  }

  if (oldEntry.moodChanges !== undefined) {
    subjects.symptomControl = {
      dateTime: epochTime,
      symptomControl: mapSymptomControl(oldEntry.moodChanges),
      symptomName: "Mood Change",
    };
  }

  if (oldEntry.generalMood !== undefined) {
    subjects.emotionalWellbeingMood = {
      dateTime: epochTime,
      notes: mapEmotional(oldEntry.generalMood),
    };
  }

  if (oldEntry.improvement !== undefined) {
    const note = oldEntry?.notes ? oldEntry?.notes : "";
    subjects.other = {
      dateTime: epochTime,
      name: "Overall improvement",
      notes: `${mapOverall(oldEntry.sleepQuality)}
      ${note}`,
    };
  }

  return {
    dateTime: epochTime,
    subjects,
  };
}

function mapAppetite(num: number): string {
  switch (num) {
    case 0:
      return "extremelyDecreased";
    case 1:
      return "somewhatDecreased";
    case 2:
      return "somewhatDecreased";
    case 3:
      return "regular";
    case 4:
      return "somewhatIncreased";
    case 5:
      return "somewhatIncreased";
    case 6:
      return "extremelyIncreased";
    default:
      return "unknown";
  }
}

function mapEnergyLevels(num: number): string {
  switch (num) {
    case 0:
      return "noPain";
    case 1:
      return "hurtsALittle";
    case 2:
      return "hurtsALittle";
    case 3:
      return "hurtsALittleMore";
    case 4:
      return "hurtsWholeLot";
    case 5:
      return "hurtsWholeLot";
    case 6:
      return "hurtsWorst";
    default:
      return "unknown";
  }
}

function mapSleepDurationLevels(num: number): string {
  switch (num) {
    case 0:
      return "extremelyShort";
    case 1:
      return "somewhatShort";
    case 2:
      return "somewhatShort";
    case 3:
      return "average";
    case 4:
      return "somewhatLong";
    case 5:
      return "somewhatLong";
    case 6:
      return "extremelyLong";
    default:
      return "unknown";
  }
}

function mapSleepQualityLevels(num: number): string {
  switch (num) {
    case 0:
      return "veryPoor";
    case 1:
      return "poor";
    case 2:
      return "average";
    case 3:
      return "good";
    case 4:
      return "excellent";
    default:
      return "unknown";
  }
}

function mapSymptomControl(num: number): string {
  switch (num) {
    case 0:
      return "none";
    case 1:
      return "veryLow";
    case 2:
      return "medium";
    case 3:
      return "high";
    case 4:
      return "veryHigh";
    default:
      return "unknown";
  }
}

function mapOverall(num: number): string {
  switch (num) {
    case 0:
      return "No Improvement Yet";
    case 1:
      return "Slight Improvement";
    case 2:
      return "Some Improvement";
    case 3:
      return "Significant Improvement";
    case 4:
      return "Great";
    default:
      return "unknown";
  }
}

function mapEmotional(num: number): string {
  switch (num) {
    case 0:
      return "Poor";
    case 1:
      return "Fair";
    case 2:
      return "Good";
    case 3:
      return "Very good";
    case 4:
      return "Excellent";
    default:
      return "unknown";
  }
}

//************* Events / Doses ******************/

function transformEventAndDoses(
  oldEvent: any,
  selectedEventKey: string,
  dosesObj: any,
  newChild: any
) {
  // parse event fields
  const eventId = selectedEventKey || db.ref().push().key;
  const createDate = parseDate(oldEvent.create_date);

  // maybe get newChild.dosages.acetaminophen.dose
  // or something to feed into your event doc
  // const dosageType = getDosageByName(
  //   newChild?.dosages,
  //   oldEvent.cycle === "ibprofen" ? "ibuprofen" : oldEvent.cycle
  // );

  let dosageType: any;

  // build the doc
  const newEventDoc: any = {
    childId: oldEvent.child_id,
    createDate,
    cycle:
      oldEvent.cycle === "both"
        ? "alternating"
        : oldEvent.cycle === "ibprofen"
          ? "ibuprofen"
          : oldEvent.cycle,
    dosageType: {},
    dosageGiven: [], // we fill below
    eventId: eventId,
    initialDoseStart: parseDate(oldEvent.initial_dose_date),
    // lastDoseGiven: not defined
    nextScheduledDose: parseDate(oldEvent.next_scheduled_dose_date),
    state: oldEvent.state,
  };
  if (oldEvent.cycle === "both") {
    newEventDoc.dosageType = newChild.dosages;
  } else {
    dosageType = getDosageByName(
      newChild?.dosages,
      oldEvent.cycle === "ibprofen" ? "ibuprofen" : oldEvent.cycle
    );
    newEventDoc.dosageType[
      oldEvent.cycle === "ibprofen" ? "ibuprofen" : oldEvent.cycle
    ] = dosageType;
  }

  //Sort the doses by `index`
  const sortedDoses = sortDosesByIndex(dosesObj);

  // transform each dose
  for (const [doseKey, dose] of sortedDoses) {
    newEventDoc.dosageGiven.push(
      transformDose(
        dose,
        newEventDoc.dosageType,
        doseKey,
        parseDate(oldEvent.next_scheduled_dose_date),
        oldEvent.cycle
      )
    );

    // after 1st dose of notGiven, break out of the loop
    if ((dose as any).state === "notGiven") {
      break;
    }
  }
  if (
    newEventDoc.dosageGiven[newEventDoc.dosageGiven.length - 1].given === true
  ) {
    const nextAmount = () => {
      if (oldEvent.cycle === "both") {
        return newEventDoc.dosageGiven[newEventDoc.dosageGiven.length - 1]
          .whatGiven === "acetaminophen"
          ? getIbuprofenLabel(newEventDoc.dosageType?.ibuprofen?.dose)
          : getAcetaminophenLabel(newEventDoc.dosageType?.acetaminophen?.dose);
      } else {
        return oldEvent.cycle === "acetaminophen"
          ? getAcetaminophenLabel(dosageType?.dose)
          : getIbuprofenLabel(dosageType?.dose);
      }
    };

    const nextWhat = () => {
      if (oldEvent.cycle === "both") {
        return newEventDoc.dosageGiven[newEventDoc.dosageGiven.length - 1]
          .whatGiven === "acetaminophen"
          ? "Ibuprofen"
          : "Acetaminophen";
      } else {
        return capitalizeFirstLetter(oldEvent.cycle);
      }
    };

    newEventDoc.dosageGiven.push({
      amountGiven: nextAmount(),
      firstDose: false,
      given: false,
      whatGiven: nextWhat(),
      timeAvailable: parseDate(oldEvent.next_scheduled_dose_date),
    });
  }

  return newEventDoc;
}

function transformDose(
  doseObj: OldDose,
  dosageType: any,
  doseKey: any,
  nextDoseTime: any,
  cycle: string
) {
  logger.log("doseKey", doseKey, doseObj);
  logger.log("dosageType", dosageType);

  const nextAmount = () => {
    if (cycle === "both") {
      return doseObj.medication === "acetaminophen"
        ? getIbuprofenLabel(dosageType?.ibuprofen?.dose)
        : getAcetaminophenLabel(dosageType?.acetaminophen?.dose);
    } else {
      return doseObj.medication === "acetaminophen"
        ? getAcetaminophenLabel(dosageType?.dose)
        : getIbuprofenLabel(dosageType?.dose);
    }
  };

  const doseInfo: NewDose = {
    index: doseObj.index,
    amountGiven: nextAmount(),
    firstDose: doseObj.index === 0,
    given: doseObj.state === "given",
    whatGiven: capitalizeFirstLetter(
      doseObj.medication === "ibprofen" ? "ibuprofen" : doseObj.medication
    ),
  };

  if (doseObj.state === "given") {
    doseInfo.timeGiven = parseDate(
      doseObj.given_date || doseObj.scheduled_date
    );
  } else {
    doseInfo.timeAvailable = parseDate(nextDoseTime);
  }

  return doseInfo;
}

function parseDate(dateVal: any): number {
  if (!dateVal) return 0;

  if (typeof dateVal === "number") {
    return dateVal; // Might be ms or a custom epoch
  }

  if (typeof dateVal === "string") {
    const momentDate = moment(dateVal); // Parse using Moment.js

    if (momentDate.isValid()) {
      // Check if parsing was successful
      return momentDate.valueOf(); // Get milliseconds since epoch
    } else {
      console.error(`Invalid date string: ${dateVal}`); // Log the invalid date string
      return 0; // Or handle the error as needed (e.g., throw an exception)
    }
  }

  return 0;
}

function getDosageByName(dosages: any, name: string) {
  // Just return dosages[name] if it exists:
  return dosages[name];
}

function sortDosesByIndex(dosesObj: Record<string, OldDose>) {
  // Convert to array of [key, dose] pairs
  const entries = Object.entries(dosesObj) as [string, any][]; // e.g. [["-O...", { index:2 }], ...]
  // Sort by dose.index
  entries.sort(
    ([keyA, doseA], [keyB, doseB]) => (doseA.index ?? 0) - (doseB.index ?? 0)
  );
  return entries;
}

//************* Prescription / Doses ******************/

// 1) The function that migrates all prescriptions for a given child
async function migratePrescriptionsForChild(childId: string, timeZone: string) {
  // Step A: read old "prescription" data from the old DB
  const prescriptionSnap = await onCureDb
    .ref("/prescription")
    .orderByChild("child_id")
    .equalTo(childId)
    .once("value");

  const oldPrescriptions = prescriptionSnap.val() || {};

  // Step B: build updates
  const multiLocUpdates: Record<string, any> = {};

  // Convert each object in oldPrescriptions => array
  const oldPresArray = Object.entries(oldPrescriptions).map(([key, val]) => ({
    prescriptionId: key,
    ...(val as OldPrescription),
  }));

  // Filter out isDeleted
  const activePrescriptions = oldPresArray.filter((p) => p.isDeleted !== true);

  // Step C: Transform each old prescription => new model
  for (const oldPres of activePrescriptions) {
    const newPres = transformOldPrescriptionToNew(oldPres, timeZone);
    // decide an ID in the new DB
    const newId = oldPres.prescriptionId || db.ref().push().key; // reuse old ID or push key

    // we store at /prescription/{newId}
    multiLocUpdates[`/prescription/${newId}`] = newPres;

    // 4) Create the event object
    let newEvent = createPrescriptionEvent(newPres, oldPres, timeZone);
    logger.log("newEvent", newEvent);
    // We'll give it an ID (eventId)
    const newEventId = `pe-${newId}`;
    newEvent.eventId = newEventId!;

    // Insert under /prescription_events/{newEventId}
    multiLocUpdates[`/prescription_events/${newEventId}`] = newEvent;

    // C) Fetch + transform doses
    const dosesSnap = await onCureDb
      .ref("/prescription_doses")
      .orderByChild("prescription_id")
      .equalTo(oldPres.prescriptionId) // match old ID
      .once("value");

    const oldDoses = dosesSnap.val() || {};

    logger.log("oldDoses", oldDoses);
    // Convert => array
    const oldDosesArray = Object.entries(oldDoses).map(([doseId, doseVal]) => ({
      doseId,
      ...(doseVal as OldPrescriptionDose),
    }));

    // Filter out any state = "notGiven"
    const givenDoses = oldDosesArray.filter((d) => d.state !== "notGiven");

    // Transform each dose => new model
    const newDoses = givenDoses.map((oldDose) =>
      transformOldPrescriptionDoseToNew(oldDose, newPres, newEventId)
    );
    logger.log("newDoses", newDoses);
    for (const nd of newDoses) {
      const doseId = nd.id || db.ref().push().key;
      // e.g. "/prescription/{presId}/doses/{doseId}"
      multiLocUpdates[`/prescription_doses/${doseId}`] = nd;
    }
  }

  // Step D: write all at once (if desired)
  // await db.ref().update(multiLocUpdates);
  return multiLocUpdates;
}

function transformOldPrescriptionToNew(
  oldPres: OldPrescription,
  userTimeZone: string
): Prescription {
  const now = Date.now();

  // 1) Clone oldPres so we can remove mapped fields
  const leftover = { ...oldPres };

  // 2) Parse startDate => epoch
  const startDateMs = parseDate(oldPres.startDate);

  // 3) If `ongoing` = false, parse endDate => epoch
  let endDateMs: number | null = null;
  if (!oldPres.ongoing && oldPres.endDate) {
    endDateMs = parseDate(oldPres.endDate);
  }

  // 4) Build `PrescriptionDoseType`
  const dose: PrescriptionDoseType = {
    dose: oldPres.doseAmount != null ? String(oldPres.doseAmount) : "",
    unit: "other",
    unitOther: oldPres.doseUnit || "",
  };

  // 5) Build frequency
  const frequency: FrequencyType = parseOldFrequency(oldPres);
  frequency.startDate = startDateMs;

  // 6) Construct new prescription
  const newPrescription: Prescription = {
    id: oldPres.prescriptionId,
    childId: oldPres.child_id,
    parentId: oldPres.parent_id,
    name: oldPres.name || "Untitled",
    dose,
    frequency,
    duration: !oldPres.ongoing
      ? { interval: formatTwoDigits(oldPres.duration), period: "Days" }
      : null,
    startDate: startDateMs,
    endDate: endDateMs,
    reminderTimes: (oldPres.dailyReminderTimes || []).map((oldVal) =>
      convertUtcSecondsToLocalSeconds(oldVal, userTimeZone)
    ),
    dateAdded: now,
    totalDoses: !oldPres.ongoing ? frequency.interval * oldPres.duration : null,
  };

  // 7) Remove mapped fields from leftover
  //    (any field used in constructing newPrescription)
  delete leftover.prescriptionId;
  delete leftover.child_id;
  delete leftover.parent_id;
  delete leftover.name;
  delete leftover.doseAmount;
  delete leftover.doseUnit;
  delete leftover.endDate;
  delete leftover.duration;
  delete leftover.dailyReminderTimes;
  delete leftover.ongoing;
  delete leftover.startDate;
  // etc. for every field you explicitly used above

  // 8) Attach leftover under a property, e.g. `legacyFields`
  //    so you can still keep them if needed
  //    (You may not want to store them directly in newPrescription root)
  (newPrescription as any).legacyFields = leftover;

  return newPrescription;
}

function parseOldFrequency(oldPres: OldPrescription): FrequencyType {
  // Example: if oldPres.doseFrequency === "2:d", that might be "2 times daily"
  const freqString =
    oldPres.doseFrequency ??
    (oldPres.dailyFrequency != null
      ? String(oldPres.dailyFrequency)
      : undefined);

  const freqDecoded = decodeDoseFrequency(freqString);

  let frequency: FrequencyType = {
    type: FrequencyInterval.DAILY, // an enum in your new code
    interval: freqDecoded.count,
  };

  if (freqDecoded.type === DecodedFrequencyType.WEEKLY) {
    frequency = {
      type: FrequencyInterval.WEEKLY,
      interval: freqDecoded.count,
    };
  } else if (freqDecoded.type === DecodedFrequencyType.MONTHLY) {
    frequency = {
      type: FrequencyInterval.MONTHLY,
      interval: freqDecoded.count,
    };
  } else if (freqDecoded.type === DecodedFrequencyType.CUSTOM) {
    frequency = {
      type: FrequencyInterval.DAILY,
      interval: freqDecoded.count,
    };
  }

  return frequency;
}

function transformOldPrescriptionDoseToNew(
  oldDose: OldPrescriptionDose,
  newPres: Prescription,
  newEventId: string
): Doses {
  // parse date from e.g. oldDose.given_date or scheduled_date
  const dateMs =
    parseDate(oldDose.given_date) || parseDate(oldDose.scheduled_date);

  const newDose: Doses = {
    date: parseDate(oldDose.scheduled_date), // not sure
    dose: newPres.dose,
    given: oldDose.state === "given",
    id: oldDose.doseId,
    name: newPres.name, // or set from oldDose.medication if needed
    prescriptionEventId: newEventId, // or if you're using some event id; for now we link to newPresId
    timeGiven: dateMs,
    frequencyType: newPres.frequency.type, // if you want to set from something
  };

  return newDose;
}

/**
 * Decodes strings like "2:d", "3:w", "1:m" into a structured object
 * { type: 'daily' | 'weekly' | 'monthly', count: number }.
 * If the format is unrecognized, returns { type: 'custom', count: 1 } by default.
 */
function decodeDoseFrequency(freq: string | undefined): DecodedDoseFrequency {
  if (!freq) {
    return { type: DecodedFrequencyType.CUSTOM, count: 1 };
  }
  if (freq.length === 1) {
    return { type: DecodedFrequencyType.DAILY, count: parseInt(freq, 10) };
  }

  // e.g. "2:d" -> ["2", "d"]
  const [countStr, letter] = freq.split(":");
  const count = parseInt(countStr, 10) || 1;

  switch (letter) {
    case "d":
      // 2:d => daily(2)
      return { type: DecodedFrequencyType.DAILY, count };
    case "w":
      // 3:w => weekly(3)
      return { type: DecodedFrequencyType.WEEKLY, count };
    case "m":
      // 1:m => monthly(1)
      return { type: DecodedFrequencyType.MONTHLY, count };
    case "y":
      // 1:y => year(1)
      return { type: DecodedFrequencyType.MONTHLY, count: count * 12 };
    default:
      // If it's something else, fallback:
      return { type: DecodedFrequencyType.CUSTOM, count };
  }
}

function formatTwoDigits(num: number): string {
  return num < 10 ? `0${num}` : `${num}`;
}

function createPrescriptionEvent(
  newPres: Prescription, // your new mapped prescription
  oldPres: OldPrescription, // the original old data if needed
  timeZone: string
): Prescription_events {
  const nextDose = calculateNextDose(newPres, timeZone);
  logger.log("nextDose", nextDose);
  const event: Prescription_events = {
    childId: newPres.childId,
    createDate: Date.now(), // You can also parse from oldPres if you want
    eventId: "",
    nextScheduledDose: nextDose,
    prescriptionId: newPres.id,
    startDate: newPres.startDate,
    state: "active",
  };

  return event;
}

// If oldVal is in UTC seconds from midnight:
function convertUtcSecondsToLocalSeconds(
  oldVal: number,
  timeZone: string
): number {
  // 1) Build a moment in UTC for the day
  //    i.e. 1970-01-01T00:00:00Z plus oldVal seconds
  const utcMoment = moment.utc("1970-01-01 00:00:00").add(oldVal, "seconds");

  // 2) Convert that moment to the user’s local time zone
  const localMoment = utcMoment.tz(timeZone);

  // 3) Compute localSeconds from midnight local
  //    For that same date. E.g. localMoment.hour()*3600 + localMoment.minute()*60 ...
  const localSeconds =
    localMoment.hours() * 3600 +
    localMoment.minutes() * 60 +
    localMoment.seconds();

  return localSeconds * 1000;
}

// ****************************************************** End Data Migration ********************************

type Doses = {
  id: string;
  name: string;
  prescriptionEventId: string;
  date: number;
  givenBy?: GivenBy;
  given?: boolean;
  timeGiven?: number;
  notes?: string | null;
  adminSite?: string | null;
  adminSiteDetails?: string | null;
  dose?: any;
  frequencyType?: string;
};

type GivenBy = {
  uid?: string;
  name?: string;
  userPhotoURL?: string;
};

type Dose = {
  date: number;
  givenBy?: GivenBy;
};

type ChildData = {
  childName: string;
  childBDay?: Date;
  childPhotoURL?: string;
  weightUnitMajor?: string;
  weightUnitMinor?: string;
  weightUnit?: string;
  parentId?: string;
  childId?: string;
  dosages?: DosageType;
  eventIds?: string[];
  careFamilyId?: string;
  careFamily?: any;
};

type DosageType = {
  [key: string]: AsNeededDoseType | undefined; // Use a generic object type
};

type AsNeededDoseType = {
  dose: string;
  doseOther?: string | undefined;
  unit?: string;
  unitOther?: string;
  form?: string;
  formOther?: string;
  timeGap: string;
  maxDose: string;
  dateAdded?: number;
  dateUpdated?: number;
  name?: string;
  description?: string;
};

type OldDose = {
  state?: string;
  given_date?: string;
  medication?: string;
  index?: number;
  scheduled_date?: string;
  // plus any other fields you expect
};

type NewDose = {
  index: number;
  amountGiven: string;
  firstDose: boolean;
  given: boolean;
  whatGiven: string;
  timeGiven?: number; // note the question mark => optional
  timeAvailable?: number; // optional
};

/**
 * Represents the old Swift-based prescription model from the DB.
 */
type OldPrescription = {
  uid?: string; // sometimes the Swift code sets uid = <Firebase key>
  apiVersion?: string; // e.g. "1.1"
  name?: string; // e.g. "Ad"
  doseAmount?: number; // e.g. 5
  doseUnit?: string; // e.g. "milliliters(solution)" or "patches"
  dailyFrequency?: number; // e.g. 2
  doseFrequency?: string; // e.g. "2:d", "1:d"
  duration?: number; // e.g. 370
  startDate?: string; // "2025-02-05T05:00:00.000+0000"
  endDate?: string; // "2026-02-10T05:00:00.000+0000"
  initialDoseDate?: string; // "2025-02-05T22:11:00.000+0000"
  dailyReminderTimes?: number[]; // e.g. [39600, 82800]
  parent_id?: string; // e.g. "zvi7h7AsSqSfacqp7tB89IwHny72"
  child_id: string; // e.g. "-LP1vPvLpbi1nkqeudV_"
  childsName?: string; // "Emily Golan"
  isDeleted?: boolean; // e.g. false
  ongoing?: boolean; // e.g. true
  givenDosesNeedUpdate?: boolean;
  docReminderFrequency?: string; // e.g. "1:m", "2:w"
  docAppointmentTime?: number; // e.g. -1740546000
  prescriptionId?: string;
};

type Prescription = {
  id?: string;
  childId: string;
  parentId: string;
  name: string;
  dose: PrescriptionDoseType;
  frequency: FrequencyType; // FrequencyType to handle various scheduling needs
  duration?: DurationType | null; // Optional duration in days or total doses
  startDate: number; // Timestamp for the start date
  endDate?: number | null; // Optional end date, calculated from startDate and duration
  reminderTimes?: number[]; // Array of reminders per day, if applicable
  dateAdded?: number; // Timestamp for when the prescription was added
  dateUpdated?: number; // Optional timestamp for the last update
  notes?: string | null; // Additional notes about the prescription
  shapeAndColor?: string | null; // Additional notes about the prescription
  conditionReason?: string | null; // Additional notes about the prescription
  totalDoses?: number | null;
};

type Prescription_events = {
  childId: string;
  prescriptionId: string;
  createDate?: number;
  cycle?: string;
  startDate?: number;
  lastDoseGiven?: number;
  nextScheduledDose?: number;
  nextNotificationTime?: number; // added after 1st notification
  notificationCount?: number; // to indicate notification count
  snoozeInterval?: number; // TODO add to event when snoozed notification?
  state?: string;
  eventId?: string;
};

/**
 * Represents an old dose object from 'prescription_doses'.
 */
type OldPrescriptionDose = {
  apiVersion?: string; // e.g. "1.1"
  caregiver_id?: string; // e.g. "zvi7h7AsSqSfacqp7tB89IwHny72"
  given_date?: string; // "2025-02-06T04:14:30.801+0000"
  prescription_id?: string; // matches the old prescription key
  scheduled_date?: string; // "2025-02-06T04:14:26.716+0000"
  state?: string; // e.g. "given", "notGiven"
  doseAmount?: number; // If it existed, bridging from Swift's 'doseAmount'
  doseUnit?: string; // bridging from 'doseUnit'
  // ...any other fields you see in the Swift side
  index?: number; // if the Swift code stored a dose index
  doseId?: string;
};

type PrescriptionDoseType = {
  dose: string;
  doseOther?: string;
  unit?: string;
  unitOther?: string;
  form?: string;
  formOther?: string;
  name?: string;
  description?: string;
  dateAdded?: number;
  dateUpdated?: number;
};

type DurationType = {
  interval: string;
  period: string;
};

type FrequencyType = {
  type: FrequencyInterval; // Enum to specify the type of frequency (see below)
  interval?: number; // Number of hours, days, or weeks, depending on the type
  daysOfWeek?: DaysOfWeek[]; // Array of days for weekly or specific day frequencies
  timeOfDay?: number; // Array of time for time frequencies
  startDate?: number;
  monthsInterval?: number; // For frequencies specified in months
};

enum FrequencyInterval {
  HOURLY = "hourly", // ok
  DAILY = "daily", // ok
  EVERY_OTHER_DAY = "every_other_day",
  WEEKLY = "weekly", // ok
  ONCE_A_WEEKLY = "once_a_week",
  CERTAIN_DAYS = "certain_days", // ok // For specifying particular days of the week
  MONTHLY = "monthly", // ok
  CUSTOM = "custom", // For any custom frequency that doesn't fit above types
}

enum DecodedFrequencyType {
  DAILY = "daily",
  WEEKLY = "weekly",
  MONTHLY = "monthly",
  YEARLY = "yearly",
  CUSTOM = "custom",
}

type DecodedDoseFrequency = {
  type: DecodedFrequencyType;
  count: number; // e.g. 2 if "2:d"
};

// Days of the week for SPECIFIC_DAYS frequency type
export enum DaysOfWeek {
  SUNDAY = "Sunday",
  MONDAY = "Monday",
  TUESDAY = "Tuesday",
  WEDNESDAY = "Wednesday",
  THURSDAY = "Thursday",
  FRIDAY = "Friday",
  SATURDAY = "Saturday",
}
