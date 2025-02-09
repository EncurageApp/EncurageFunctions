import * as v1 from "firebase-functions/v1";
// import * as v2 from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import moment from "moment-timezone";
import axios from "axios";
import { google } from "googleapis";

const serviceAccount = require("../oncure-app-firebase-adminsdk-j41yq-34921b17e4.json");

// 1) Default app
admin.initializeApp(
  {
    databaseURL: "https://encurage-new-default-rtdb.firebaseio.com",
  },
  "defaultApp"
);

// 2) Secondary app
admin.initializeApp(
  {
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://oncure-app.firebaseio.com/",
  },
  "onCureApp"
);

// Get the database reference for each
const db = admin.app("defaultApp").database();
const onCureDb = admin.app("onCureApp").database();

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// export const newChildAdded = v1.database
//   .ref("children/{childId}")
//   .onCreate(async (snapshot, context) => {
//     const childId = context.params.childId; // Get the childId from the context
//     // const child = snapshot.val();

//     // Call the function to create a folder with the same childId
//     await addFolderToChild(childId, "general");

//     return null; // Indicate completion
//   });

// Function to add a folder with a random ID to the child's folder array
// const addFolderToChild = async (childId, folderName) => {
//   // Reference to the child's folders array
//   const folderRef = db.ref(`/folders/${childId}`);

//   // Push a new folder with a random ID
//   const newFolderRef = folderRef.push(); // This generates a unique ID for the folder

//   await newFolderRef.set({
//     id: newFolderRef.key, // Use the generated key as the folder ID
//     name: folderName,
//     createdAt: admin.database.ServerValue.TIMESTAMP,
//   });

//   return newFolderRef.key; // Return the unique key of the new folder
// };

export const deleteExpiredCodesCron = v1.pubsub
  .schedule("0 0 * * *")
  .onRun(async (context) => {
    logger.log("daily_job ran");

    const caregiverInviteRef = db.ref("caregiver_invite");
    const currentTime = Date.now();

    try {
      // Fetch all caregiver_invite entries
      const snapshot = await caregiverInviteRef.once("value");

      if (!snapshot.exists()) {
        logger.log("No caregiver invites found.");
        return null;
      }

      const expiredDeletes = [];
      snapshot.forEach((childSnapshot) => {
        const inviteData = childSnapshot.val();
        if (inviteData.expirationTime <= currentTime) {
          // Schedule deletion of expired code
          expiredDeletes.push(childSnapshot.ref.remove());
        }
      });

      // Execute all delete promises
      await Promise.all(expiredDeletes);

      logger.log("Expired codes deleted successfully.");
      return { message: "Expired codes cleanup completed" };
    } catch (error) {
      logger.error("Error deleting expired codes:", error);
      throw new v1.https.HttpsError(
        "internal",
        "An error occurred during expired code cleanup."
      );
    }
  });
//
export const pushCron = v1.pubsub.schedule("*/1 * * * *").onRun((context) => {
  logger.log("minute_job ran");
  return checkForOutStandingNotifications()
    .then((result) => {
      logger.log("minute_job finished", { result });
      return result;
    })
    .catch((error) => {
      logger.log("minute_job error", error);
      return error;
    });
});

function checkForOutStandingNotifications() {
  return Promise.all([
    checkEventDoses().catch((error) => {
      // Catch any error that occurs so we do not stop the prescription notifications
      logger.error("An error occurred in checkForEventNotifications", error);
      return error;
    }),
    checkNextNotificationTime().catch((error) => {
      // Catch any error that occurs so we do not stop the event notifications
      logger.error(
        "An error occurred in checkForPrescriptionNotifications",
        error
      );
      return error;
    }),
    processPrescriptionEvents().catch((error) => {
      // Catch any error that occurs so we do not stop the event notifications
      logger.error("An error occurred in processPrescriptionEvents", error);
      return error;
    }),
    processPrescriptionNextNotificationTime().catch((error) => {
      // Catch any error that occurs so we do not stop the event notifications
      logger.error(
        "An error occurred in processPrescriptionNextNotificationTime",
        error
      );
      return error;
    }),
  ]);
}

const checkEventDoses = async () => {
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
      const promise = getChild(event.childId)
        .then((child) => {
          if (!child) {
            throw new Error(`Child not found for ID ${event.childId}`);
          }
          return getUser(child.parentId).then(async (parent) => {
            if (!parent) {
              throw new Error(`Parent not found for ID ${child.parentId}`);
            }

            // Prepare notification message
            const notificationBody = `${
              child.childName
            } can get the next ${capitalizeFirstLetter(
              event.cycle
            )} dose now. Tap to give the dose.`;

            // Fetch care family members
            const careFamilyMembers = await fetchCareFamilyMembers(
              child.parentId,
              event.childId
            );
            const eligibleMembers = careFamilyMembers.filter(
              (member) => member.allowsPushNotifications
            );

            // Send notification to parent if they allow push notifications
            if (parent.allowsPushNotifications) {
              await sendPushNotificationsToUser(parent.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
                screen: "EpisodeSchedule",
              });
            }

            // Send notifications to eligible care family members
            const memberPromises = eligibleMembers.map((member) =>
              sendPushNotificationsToUser(member.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
                screen: "EpisodeSchedule",
              })
            );
            await Promise.all(memberPromises);

            // Update nextNotificationTime and notificationCount
            const nextNotificationTime = currentTime + 10 * 60 * 1000; // Add 10 minutes
            return db
              .ref(`events/${childSnapshot.key}`)
              .update({ nextNotificationTime, notificationCount: 1 });
          });
        })
        .catch((error) => {
          logger.error(
            `checkEventDoses Error for childId: ${event.childId}`,
            error
          );
        });

      promises.push(promise);
    }
  });

  await Promise.all(promises);

  return null;
};

const checkNextNotificationTime = async () => {
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
      const promise = getChild(event.childId)
        .then((child) => {
          if (!child)
            throw new Error(`Child not found for ID ${event.childId}`);

          return getUser(child.parentId).then(async (parent) => {
            if (!parent)
              throw new Error(`Parent not found for ID ${child.parentId}`);

            // Fetch care family members
            const careFamilyMembers = await fetchCareFamilyMembers(
              child.parentId,
              event.childId
            );
            const eligibleMembers = careFamilyMembers.filter(
              (member) => member.allowsPushNotifications
            );

            // Send notification to parent if they allow push notifications
            const notificationBody = getNotificationMessage(child, event);

            if (parent.allowsPushNotifications) {
              await sendPushNotificationsToUser(parent.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
                screen: "EpisodeSchedule",
              });
            }

            // Send notification to eligible care family members
            const memberPromises = eligibleMembers.map((member) =>
              sendPushNotificationsToUser(member.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
                screen: "EpisodeSchedule",
              })
            );
            await Promise.all(memberPromises);

            // Update next notification time after sending
            return updateEventNotificationCount(
              event,
              childSnapshot.key,
              currentTime
            );
          });
        })
        .catch((error) => {
          logger.error(
            `checkNextNotificationTime Error for childId: ${event.childId}`,
            error
          );
        });

      promises.push(promise);
    }
  });

  await Promise.all(promises);

  return null;
};

const processPrescriptionEvents = async () => {
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
      const promise = getChild(event.childId)
        .then((child) => {
          if (!child) {
            throw new Error(`Child not found for ID ${event.childId}`);
          }
          return getUser(child.parentId).then(async (parent) => {
            if (!parent) {
              throw new Error(`Parent not found for ID ${child.parentId}`);
            }

            const prescription = await getPrescription(event.prescriptionId);

            // Prepare notification message
            const notificationBody = `It's time for ${
              child.childName
            }'s next dose of ${capitalizeFirstLetter(
              prescription.name
            )}. Tap to give the dose.`;

            // Fetch care team members
            const careFamilyMembers = await fetchCareFamilyMembers(
              child.parentId,
              event.childId
            );
            const eligibleMembers = careFamilyMembers.filter(
              (member) => member.allowsPushNotifications
            );

            // Send notification to caregiver if they allow push notifications
            if (parent.allowsPushNotifications) {
              await sendPushNotificationsToUser(parent.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
                screen: "PrimarySchedule",
              });
            }

            // Send notifications to eligible care team members
            const memberPromises = eligibleMembers.map((member) =>
              sendPushNotificationsToUser(member.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
                screen: "PrimarySchedule",
              })
            );
            await Promise.all(memberPromises);

            // Update nextNotificationTime and notificationCount
            const nextNotificationTime = currentTime + 10 * 60 * 1000; // Add 10 minutes
            return db
              .ref(`prescription_events/${childSnapshot.key}`)
              .update({ nextNotificationTime, notificationCount: 1 });
          });
        })
        .catch((error) => {
          logger.error(
            `Error processing prescription dose for child: ${event.childId}`,
            error
          );
        });

      promises.push(promise);
    }
  });

  await Promise.all(promises);

  return null;
};

const processPrescriptionNextNotificationTime = async () => {
  const currentTime = Date.now();
  const startOfMinute = getStartOfMinute(currentTime);
  const endOfMinute = getEndOfMinute(currentTime);

  const snapshot = await db
    .ref("prescription_events")
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
      const promise = getChild(event.childId)
        .then((child) => {
          if (!child)
            throw new Error(`Child not found for ID ${event.childId}`);

          return getUser(child.parentId).then(async (parent) => {
            if (!parent)
              throw new Error(`Parent not found for ID ${child.parentId}`);

            // Fetch care family members
            const careFamilyMembers = await fetchCareFamilyMembers(
              child.parentId,
              event.childId
            );

            const eligibleMembers = careFamilyMembers.filter(
              (member) => member.allowsPushNotifications
            );

            const prescription = await getPrescription(event.prescriptionId);

            // Send notification to parent if they allow push notifications
            const notificationBody = prescriptionNotification(
              child.childName,
              event.notificationCount,
              prescription.name
            );

            if (parent.allowsPushNotifications) {
              await sendPushNotificationsToUser(parent.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
                screen: "PrimarySchedule",
              });
            }

            // Send notification to eligible care family members
            const memberPromises = eligibleMembers.map((member) =>
              sendPushNotificationsToUser(member.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
                screen: "PrimarySchedule",
              })
            );
            await Promise.all(memberPromises);

            // Update next notification time after sending
            return updatePrescriptionEventNotificationCount(
              event,
              eventId,
              currentTime,
              prescription,
              parent.timeZone
            );
          });
        })
        .catch((error) => {
          logger.error(
            `Error processing dose for childId: ${event.childId}`,
            error
          );
        });

      promises.push(promise);
    }
  });

  await Promise.all(promises);

  return null;
};

function getNotificationMessage(child: any, event: any): string {
  const notificationCount = event.notificationCount;
  const cycle = capitalizeFirstLetter(event.cycle);
  const childName = child.childName;
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
  prescriptionName: any
): string {
  const medName = capitalizeFirstLetter(prescriptionName);

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

function updatePrescriptionEventNotificationCount(
  event: any,
  eventId: string,
  currentTime: number,
  prescription: any,
  timeZone: string
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
  }

  const newNotificationCount = event.notificationCount + 1;
  const updates: Partial<{
    state: string;
    nextNotificationTime: number | null;
    notificationCount: number | null;
    snoozeInterval: number | null;
    nextScheduledDose: any;
  }> =
    newNotificationCount === 5
      ? {
          nextNotificationTime: null,
          notificationCount: null,
          snoozeInterval: null,
        }
      : { nextNotificationTime, notificationCount: newNotificationCount };

  if (newNotificationCount === 5) {
    // Add a new dose to the "prescription_doses" collection
    const newDoseRef = db.ref("prescription_doses").push();
    const dose = {
      id: newDoseRef.key,
      prescriptionEventId: eventId,
      date: event.nextScheduledDose,
      given: false,
      frequencyType: prescription.frequency,
      name: prescription.name,
      dose: prescription.dose,
    };
    newDoseRef.set(dose);
    // Update the event with a new nextScheduledDose time
    const timeStamp = calculateNextDose(prescription, timeZone);
    logger.log("timeStamp", timeStamp);
    updates.nextScheduledDose = timeStamp;
  }

  return db.ref(`prescription_events/${eventId}`).update(updates);
}

const fetchCareFamilyMembers = async (parentId: string, childID: string) => {
  try {
    const careFamilySnapshot = await db
      .ref("caregiver")
      .orderByChild("parent_id")
      .equalTo(parentId)
      .once("value");

    const careFamilyMembers = [];
    careFamilySnapshot.forEach((snapshot) => {
      const memberData = snapshot.val();
      // Only add caregiver if their `childs` array contains the specified `childID`
      if (memberData.children && memberData.children.includes(childID)) {
        careFamilyMembers.push(memberData);
      }
    });

    const caregiverPromises = careFamilyMembers.map(async (caregiver) => {
      const caregiverData = await db
        .ref(`users/${caregiver.caregiver_id}`)
        .once("value");

      const caregiverDetails = caregiverData.val();
      return caregiverDetails && caregiverDetails.allowsPushNotifications
        ? caregiverDetails
        : null;
    });

    const validCaregivers = (await Promise.all(caregiverPromises)).filter(
      Boolean
    );

    return validCaregivers; // Return caregivers with allowsPushNotifications === true
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
    : admin
        .database()
        .ref(`/children/${childId}`)
        .once("value")
        .then((userSnapshot) => {
          return userSnapshot.exists
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
    : admin
        .database()
        .ref(`/users/${userId}`)
        .once("value")
        .then((userSnapshot) => {
          return userSnapshot.exists
            ? Object.assign({}, userSnapshot.val(), { id: userSnapshot.key })
            : undefined;
        });
}

function sendPushNotificationsToUser(
  userId: string,
  payload: string,
  data?: any
) {
  const pushTokensRef = admin.database().ref(`/users/${userId}/pushToken`);
  return pushTokensRef
    .once("value")
    .then((snapshot): any => {
      if (!snapshot.exists()) {
        logger.log(
          `No push token found for user ${userId}. Cannot send notification.`
        );
        return { successCount: 0, failureCount: 0, results: [] };
      }

      const recipientPushToken = snapshot.val();
      const threadId = data?.eventId;

      const androidConfig: admin.messaging.AndroidConfig = {
        priority: "high",
        collapseKey: threadId || "default", // Use a unique key for Android notifications
      };

      const iosConfig: admin.messaging.ApnsConfig = {
        headers: {
          "apns-priority": "10", // Set the priority for iOS (10 is the highest)
        },
        payload: {
          aps: {
            sound: "default",
            // badge: 0,
            "content-available": 1,
            "thread-id": threadId || "default", // Unique thread ID for grouping
          },
        },
      };

      const message: admin.messaging.Message = {
        token: recipientPushToken,
        notification: {
          title: "Encurage",
          body: payload,
        },
        data: {
          ...data,
        },
        android: androidConfig,
        apns: iosConfig,
      };
      return admin.messaging().send(message);
    })
    .then((response: any) => {
      logger.log(`Successfully sent message:`, response);
      return Promise.resolve(response);
    })
    .catch((error) => {
      logger.error("sendPushNotificationsToUser error", error);
    });
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

export function calculateNextDose(prescription: any, timeZone: string): number {
  const { frequency, startDate, reminderTimes } = prescription || {};
  const currentTime = moment.tz(timeZone).valueOf();
  logger.log("currentTime", currentTime);

  // Ensure nextDose is at least `startDate` and after the current time
  let nextDose = Math.max(
    moment.tz(startDate, timeZone).valueOf(),
    currentTime
  );

  switch (frequency?.type) {
    case FrequencyInterval.HOURLY:
      if (!frequency?.interval) {
        throw new Error("Frequency interval is required for HOURLY type.");
      }
      const hourlyInterval = frequency.interval * 60 * 60 * 1000; // Convert hours to ms
      nextDose = new Date(startDate).getTime(); // Start from the given startDate

      // Increment by the interval until nextDose is after the current time
      while (nextDose <= currentTime) {
        nextDose += hourlyInterval;
      }
      break;

    case FrequencyInterval.DAILY:
      if (
        !frequency?.interval ||
        !reminderTimes ||
        reminderTimes.length === 0
      ) {
        throw new Error(
          "Frequency interval and reminderTimes are required for DAILY type."
        );
      }

      const dailyStart = Math.max(new Date(startDate).getTime(), currentTime);
      let searchDate = new Date(dailyStart);

      while (true) {
        const dayMidnight = moment
          .tz(
            {
              year: searchDate.getFullYear(),
              month: searchDate.getMonth(), // Month is 0-indexed in both JavaScript Date and moment
              day: searchDate.getDate(),
              hour: 0,
              minute: 0,
              second: 0,
            },
            timeZone
          )
          .valueOf(); // Returns the epoch time in milliseconds

        for (const reminderTime of reminderTimes) {
          const potentialDose = dayMidnight + reminderTime;
          if (
            potentialDose > currentTime &&
            potentialDose >= moment.tz(startDate, timeZone).valueOf()
          ) {
            nextDose = potentialDose;
            break;
          }
        }

        if (nextDose > currentTime) {
          break;
        }

        searchDate = new Date(dayMidnight + 24 * 60 * 60 * 1000);
      }
      break;

    case FrequencyInterval.WEEKLY:
      if (
        !frequency?.interval ||
        !reminderTimes ||
        reminderTimes.length === 0
      ) {
        throw new Error(
          "Frequency interval and reminderTimes are required for WEEKLY type."
        );
      }

      const weeklyInterval = frequency.interval * 7 * 24 * 60 * 60 * 1000; // weeks in ms
      let weeklyTime = new Date(startDate).getTime() + reminderTimes[0]; // First dose: startDate + first reminder time
      while (weeklyTime <= currentTime) {
        weeklyTime += weeklyInterval;
      }

      nextDose = weeklyTime;
      break;

    case FrequencyInterval.CERTAIN_DAYS:
      if (!frequency?.daysOfWeek || frequency?.daysOfWeek.length === 0) {
        throw new Error("Days of the week are required for CERTAIN_DAYS type.");
      }
      if (!reminderTimes || reminderTimes.length === 0) {
        throw new Error("Reminder times are required for CERTAIN_DAYS type.");
      }

      let searchTime = Math.max(new Date(startDate).getTime(), currentTime);
      while (true) {
        const searchDateObj = new Date(searchTime);
        const currentDayIndex = searchDateObj.getDay();

        if (frequency.daysOfWeek.includes(currentDayIndex)) {
          const dayMidnight = moment
            .tz(
              {
                year: searchDateObj.getFullYear(),
                month: searchDateObj.getMonth(),
                day: searchDateObj.getDate(),
                hour: 0,
                minute: 0,
                second: 0,
              },
              timeZone
            )
            .valueOf();

          for (const reminderTime of reminderTimes) {
            const potentialDose = dayMidnight + reminderTime;
            if (
              potentialDose > currentTime &&
              potentialDose >= moment.tz(startDate, timeZone).valueOf()
            ) {
              nextDose = potentialDose;
              break;
            }
          }

          if (nextDose > currentTime) {
            break;
          }
        }

        searchTime += 24 * 60 * 60 * 1000; // Add a day
      }
      break;

    case FrequencyInterval.MONTHLY:
      if (
        !frequency?.interval ||
        !reminderTimes ||
        reminderTimes.length === 0
      ) {
        throw new Error(
          "Months interval and reminderTimes are required for MONTHLY type."
        );
      }

      let monthlyTime = new Date(startDate).getTime() + reminderTimes[0]; // First dose: startDate + first reminder time

      while (monthlyTime <= currentTime) {
        const currentDateObj = new Date(monthlyTime);
        const nextMonthDate = new Date(
          currentDateObj.getFullYear(),
          currentDateObj.getMonth() + frequency.interval,
          currentDateObj.getDate(),
          currentDateObj.getHours(),
          currentDateObj.getMinutes(),
          currentDateObj.getSeconds()
        );
        monthlyTime = nextMonthDate.getTime();
      }

      nextDose = monthlyTime;
      break;

    case FrequencyInterval.EVERY_OTHER_DAY:
      if (!reminderTimes || reminderTimes.length === 0) {
        throw new Error(
          "Reminder times are required for EVERY_OTHER_DAY type."
        );
      }

      const everyOtherDayInterval = 2 * 24 * 60 * 60 * 1000; // 2 days in ms
      nextDose = new Date(startDate).getTime();

      while (true) {
        const nextDoseDate = new Date(nextDose);
        const dayMidnight = moment
          .tz(
            {
              year: nextDoseDate.getFullYear(),
              month: nextDoseDate.getMonth(),
              day: nextDoseDate.getDate(),
              hour: 0,
              minute: 0,
              second: 0,
            },
            timeZone
          )
          .valueOf();

        let foundDose = false;
        for (const reminderTime of reminderTimes) {
          const potentialDose = dayMidnight + reminderTime;
          if (potentialDose > currentTime) {
            nextDose = potentialDose;
            foundDose = true;
            break;
          }
        }

        if (foundDose) {
          break;
        }

        nextDose += everyOtherDayInterval;
      }
      break;
    case FrequencyInterval.ONCE_A_WEEKLY:
      if (!reminderTimes || reminderTimes.length === 0) {
        throw new Error("Reminder times are required for ONCE_A_WEEKLY type.");
      }

      // ONCE_A_WEEKLY implies a 1-week interval
      const onceWeeklyInterval = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
      let onceWeeklyTime = startDate + reminderTimes[0]; // The first occurrence is startDate + reminderTime

      // If the first occurrence is in the past, move forward week by week until it's in the future
      while (onceWeeklyTime <= currentTime) {
        onceWeeklyTime += onceWeeklyInterval;
      }

      nextDose = onceWeeklyTime;
      break;

    default:
      throw new Error("Unsupported frequency type.");
  }

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
      const inviteRef = await admin
        .database()
        .ref("caregiver_invite")
        .push(inviteData);
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

      return sendPushNotificationsToUser(
        parent.uid,
        `${userName} has accepted your invitation, and joined the care family. You can now complete the setup in the Care Family tab.`,
        { screen: "Caregivers" }
      )
        .then(() => {})
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
      await admin
        .database()
        .ref(`/users/${userId}`)
        .update({
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

      await admin
        .database()
        .ref(`/users/${userId}`)
        .update({
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
    const userRef = admin.database().ref(`/users/${userId}`);
    const userSnapshot = await userRef.once("value");
    const userData = userSnapshot.val();

    if (
      !userData ||
      (!userData.purchaseInfo?.transactionReceipt &&
        !userData.purchaseInfo?.purchaseToken)
    ) {
      logger.warn(
        `No subscription data found for user: ${userId}. Data: ${JSON.stringify(
          userData
        )}`
      );
    }

    logger.log(
      `User subscription data retrieved: ${JSON.stringify(
        userData.purchaseInfo
      )}`
    );

    let validationResponse;
    const now = Date.now();
    let isSubscribed = false;
    let subscriptionExpiry = null;
    let updatedPurchaseInfo = { ...userData.purchaseInfo };

    const applyGracePeriod = (expiryMillis, isAnnual) => {
      const gracePeriod = isAnnual
        ? 14 * 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
      return expiryMillis + gracePeriod > now;
    };

    if (userData.purchaseInfo?.transactionReceipt) {
      logger.log("Validating with Apple...");

      validationResponse = await validateAppleReceipt(
        userData.purchaseInfo.transactionReceipt
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
          updatedPurchaseInfo.transactionReceipt =
            validationResponse.latest_receipt;
        }
      } else {
        logger.warn(
          `Apple receipt validation failed with status: ${validationResponse.status}`
        );
      }
    } else if (userData.purchaseInfo?.purchaseToken) {
      logger.log("Validating with Google...");

      validationResponse = await validateGoogleReceipt(
        userData.purchaseInfo.purchaseToken,
        "com.encurage",
        userData.purchaseInfo.productId
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

exports.convertOnCureUser = v1.https.onCall(async (data, context) => {
  const { appVersion } = data;
  if (!context.auth) {
    throw new v1.https.HttpsError(
      "unauthenticated",
      "Function must be called while authenticated."
    );
  }

  const userId = context.auth.uid;

  try {
    // 1) Fetch old user
    const userSnap = await onCureDb.ref(`/users/${userId}`).once("value");
    if (!userSnap.exists()) {
      throw new v1.https.HttpsError("not-found", `User ${userId} not found`);
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
    const email = context.auth.token.email;
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
    }

    // 6) Write all at once
    await db.ref().update(updates);

    return {
      message: "Success",
      user: newUser,
      childrenCount: childIds.length,
    };
  } catch (error) {
    console.error("Error in convertOnCureUser:", error);
    throw new v1.https.HttpsError(
      "internal",
      (error as Error)?.message || "Unknown error."
    );
  }
});

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

  // 4) Convert `dob` to epoch time if it’s a string (e.g., '1975-05-20T05:00:00.000+0000')
  if (typeof newUser.dob === "string") {
    const dateObj = new Date(newUser.dob);
    if (!isNaN(dateObj.valueOf())) {
      newUser.dob = dateObj.getTime(); // milliseconds since epoch
    } else {
      // If parsing fails, you could default to 0 or remove the field:
      newUser.dob = 0;
    }
  }

  // 5) Check for any legacy flags
  const legacyFlags = [
    "onCure360Enabled",
    "ongoingRxEnabled", // double check in xcode
    "proMembershipEnabled",
    "symptomTrackerEnabled",
    "unlimitedEpisodesEnabled",
  ];
  for (const flag of legacyFlags) {
    if (newUser[flag]) {
      // If any of these are truthy, set legacySubscription = true
      newUser.legacySubscription = true;
      break;
    }
  }

  // 6) Return the final object. You could cast to `User` if you like,
  //    but remember we are keeping extra old fields.
  return newUser;
}

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

  // 6. Build the `dosages` object from the old user_defined_* fields
  //    We'll store today's date in epoch time
  const now = Date.now();

  // Get numeric indexes (should always exist, per your spec)
  const acetIndex = Number(newChild.user_defined_acetaminophen_dose);
  const ibuIndex = Number(newChild.user_defined_ibuprofen_dose);

  // Map them to the new dose values
  const acetaminophenDoseValue = getAcetaminophenValue(acetIndex);
  const ibuprofenDoseValue = getIbuprofenValue(ibuIndex);

  // Create the `dosages` object
  newChild.dosages = {
    acetaminophen: {
      dateAdded: now,
      dose: acetaminophenDoseValue,
      maxDose: "5",
      name: "Acetaminophen",
      timeGap: "4",
    },
    ibuprofen: {
      dateAdded: now,
      dose: ibuprofenDoseValue,
      maxDose: "4",
      name: "Ibuprofen",
      timeGap: "6",
    },
    alternating: {
      dateAdded: now,
      name: "Alternating",
      timeGap: "3",
    },
  };

  // 7. If the mapped dose is "other", check if the old dose_text field is present
  if (acetaminophenDoseValue === "other") {
    const oldAcetText = newChild.user_defined_acetaminophen_dose_text;
    if (typeof oldAcetText === "string" && oldAcetText.trim() !== "") {
      newChild.dosages.acetaminophen.doseOther = oldAcetText;
    }
  }
  if (ibuprofenDoseValue === "other") {
    const oldIbuText = newChild.user_defined_ibuprofen_dose_text;
    if (typeof oldIbuText === "string" && oldIbuText.trim() !== "") {
      newChild.dosages.ibuprofen.doseOther = oldIbuText;
    }
  }

  // Optionally, remove the old fields if you don't need them anymore
  delete newChild.user_defined_acetaminophen_dose;
  delete newChild.user_defined_acetaminophen_dose_text; // sometimes present
  delete newChild.user_defined_ibuprofen_dose;
  delete newChild.user_defined_ibuprofen_dose_text; // sometimes present

  // 8. Retain the child’s ID
  newChild.childId = childId;

  // add app version
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
  const dosageType = getDosageByName(newChild.dosages, oldEvent?.cycle);

  // build the doc
  const newEventDoc: any = {
    childId: oldEvent.child_id,
    createDate,
    cycle: oldEvent.cycle === "both" ? "alternating" : oldEvent.cycle,
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
    newEventDoc.dosageType[oldEvent.cycle] = dosageType;
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
