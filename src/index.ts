/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from 'firebase-functions/v2/https';
 * import {onDocumentWritten} from 'firebase-functions/v2/firestore';
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// import { onRequest } from 'firebase-functions/v2/https';
import * as v1 from "firebase-functions/v1";
// import * as v2 from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
admin.initializeApp();
const db = admin.database();

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

export const newChildAdded = v1.database
  .ref("children/{childId}")
  .onCreate(async (snapshot, context) => {
    const childId = context.params.childId; // Get the childId from the context
    // const child = snapshot.val();

    // Call the function to create a folder with the same childId
    await addFolderToChild(childId, "general");

    return null; // Indicate completion
  });

// Function to add a folder with a random ID to the child's folder array
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

export const deleteExpiredCodesCron = v1.pubsub
  .schedule("0 0 * * *")
  .onRun(async (context) => {
    console.log("daily_job ran");

    const caregiverInviteRef = db.ref("caregiver_invite");
    const currentTime = Date.now();

    try {
      // Fetch all caregiver_invite entries
      const snapshot = await caregiverInviteRef.once("value");

      if (!snapshot.exists()) {
        console.log("No caregiver invites found.");
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

      console.log("Expired codes deleted successfully.");
      return { message: "Expired codes cleanup completed" };
    } catch (error) {
      console.error("Error deleting expired codes:", error);
      throw new v1.https.HttpsError(
        "internal",
        "An error occurred during expired code cleanup."
      );
    }
  });
//
export const pushCron = v1.pubsub.schedule("*/1 * * * *").onRun((context) => {
  console.log("minute_job ran");
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
              });
            }

            // Send notifications to eligible care family members
            const memberPromises = eligibleMembers.map((member) =>
              sendPushNotificationsToUser(member.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
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
          console.error(
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
              });
            }

            // Send notification to eligible care family members
            const memberPromises = eligibleMembers.map((member) =>
              sendPushNotificationsToUser(member.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
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
          console.error(
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
              });
            }

            // Send notifications to eligible care team members
            const memberPromises = eligibleMembers.map((member) =>
              sendPushNotificationsToUser(member.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
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
          console.error(
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
              });
            }

            // Send notification to eligible care family members
            const memberPromises = eligibleMembers.map((member) =>
              sendPushNotificationsToUser(member.uid, notificationBody, {
                childId: event.childId,
                eventId: eventId,
              })
            );
            await Promise.all(memberPromises);

            // Update next notification time after sending
            return updatePrescriptionEventNotificationCount(
              event,
              eventId,
              currentTime,
              prescription
            );
          });
        })
        .catch((error) => {
          console.error(
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
      return `${childName}'s ${medName} dose was missed. Tap to choose how to proceed`;
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
  prescription: any
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
    const nextScheduledDose = calculateNextDose(prescription);
    updates.nextScheduledDose = nextScheduledDose;
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
    console.error("Error fetching care family members:", error);
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
        console.log(
          `No push token found for user ${userId}. Cannot send notification.`
        );
        return { successCount: 0, failureCount: 0, results: [] };
      }

      const recipientPushToken = snapshot.val();

      const androidConfig: admin.messaging.AndroidConfig = {
        priority: "high",
      };

      const iosConfig: admin.messaging.ApnsConfig = {
        headers: {
          "apns-priority": "10", // Set the priority for iOS (10 is the highest)
        },
        payload: {
          aps: {
            sound: "default",
            badge: 0,
          },
        },
      };

      const message: admin.messaging.Message = {
        token: recipientPushToken,
        notification: {
          title: "Encurage",
          body: payload,
        },
        data: data,
        android: androidConfig,
        apns: iosConfig,
      };
      return admin.messaging().send(message);
    })
    .then((response: any) => {
      console.log(`Successfully sent message:`, response);
      return Promise.resolve(response);
    })
    .catch((error) => {
      console.error("sendPushNotificationsToUser error", error);
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
    console.error(
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
    console.error("getCareFamilyName Error", error);
    throw new v1.https.HttpsError(
      "internal",
      "Unable to retrieve family name."
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

export function calculateNextDose(prescription: any): number {
  const { frequency, startDate, reminderTimes } = prescription || {};
  const currentTime = Date.now();

  // Ensure nextDose is at least `startDate` and after the current time
  let nextDose = Math.max(new Date(startDate).getTime(), currentTime);

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
        const dayMidnight = new Date(
          searchDate.getFullYear(),
          searchDate.getMonth(),
          searchDate.getDate(),
          0,
          0,
          0,
          0
        ).getTime();

        for (const reminderTime of reminderTimes) {
          const potentialDose = dayMidnight + reminderTime;
          if (
            potentialDose > currentTime &&
            potentialDose >= new Date(startDate).getTime()
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
          const dayMidnight = new Date(
            searchDateObj.getFullYear(),
            searchDateObj.getMonth(),
            searchDateObj.getDate(),
            0,
            0,
            0,
            0
          ).getTime();

          for (const reminderTime of reminderTimes) {
            const potentialDose = dayMidnight + reminderTime;
            if (
              potentialDose > currentTime &&
              potentialDose >= new Date(startDate).getTime()
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
        const dayMidnight = new Date(
          nextDoseDate.getFullYear(),
          nextDoseDate.getMonth(),
          nextDoseDate.getDate(),
          0,
          0,
          0,
          0
        ).getTime();

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
      console.log(`No entries found in folder ${folderID}`);
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
    console.error("Error moving or deleting folder entries or folder:", error);
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
    console.error("Error moving or deleting folder entry or folder:", error);
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
      console.error("Error creating caregiver invite:", error);
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
    console.error("Error verifying and adding caregiver:", error);
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
        throw new Error(`No pushToken for parent with ID ${parent.uid}`);
      }

      return sendPushNotificationsToUser(
        parent.uid,
        `${userName} accepted care family invitation. Please complete setup in app.`
      )
        .then(() => {})
        .catch((error) => {
          console.error(
            "Error sending care family invitation Push Notification",
            error
          );
        });
    });
  } catch (error) {
    console.error(
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
    console.error("Error updating care family name:", error);
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
            given: true,
            dose: prescription.dose,
          };

          return doseRef.set(doseData);
        }
      );

      // Step 4: Wait for all writes to complete
      await Promise.all([
        savePrescription,
        savePrescriptionEvent,
        ...doseWrites,
      ]);

      return {
        message: "Prescription, events, and doses added successfully",
        prescriptionId,
        prescriptionEventId,
        status: "OK",
      };
    } catch (error) {
      console.error("Error adding prescription and events:", error);
      throw new v1.https.HttpsError(
        "internal",
        "An error occurred while processing the request."
      );
    }
  }
);

export type Doses = {
  id: string;
  name: string;
  prescriptionEventId: string;
  date: number;
  givenBy?: GivenBy;
  given?: boolean;
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
