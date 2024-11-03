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

// export const helloWorld = v1.https.onRequest((request, response) => {
//   logger.info('Hello logs!', { structuredData: true });
//   response.send('Hello from Firebase!');
// });

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
      logger.error("An error occurred in checkForEventNotifications()", error);
      return error;
    }),
    checkNextNotificationTime().catch((error) => {
      // Catch any error that occurs so we do not stop the event notifications
      logger.error(
        "An error occurred in checkForPrescriptionNotifications()",
        error
      );
      return error;
    }),
  ]);
}

const checkEventDoses = async () => {
  const currentTime = Date.now();
  const startOfMinute = getStartOfMinute(currentTime);
  const endOfMinute = getEndOfMinute(currentTime); // End of current minute

  // Query for doses that are due within the current minute and have the state "active"
  const snapshot = await db
    .ref("events")
    .orderByChild("nextScheduledDose")
    .startAt(startOfMinute)
    .endAt(endOfMinute)
    .once("value");

  const promises: Promise<any>[] = [];
  console.log(
    "checkEventDose startOfMinute/endOfMinute",
    startOfMinute,
    endOfMinute
  );

  snapshot.forEach((childSnapshot) => {
    const event = childSnapshot.val();
    const eventId = childSnapshot.key; // Get the event ID
    if (event.state === "active" && !event.nextNotificationTime) {
      console.log(
        `Processing dose for childId: ${event.childId} due at ${event.nextScheduledDose}`
      );

      const promise = getChild(event.childId)
        .then((child) => {
          if (!child) {
            throw new Error(`Child not found for ID ${event.childId}`);
          }
          return getUser(child.parentId).then((parent) => {
            if (!parent) {
              throw new Error(`Parent not found for ID ${child.parentId}`);
            }
            const parentPushToken = parent?.pushToken;
            if (!parentPushToken) {
              throw new Error(`No pushToken for parent with ID ${parent.uid}`);
            }
            return sendPushNotificationsToUser(
              parent.uid,
              `${child.childName} can get the next ${capitalizeFirstLetter(
                event.cycle
              )} dose now. Tap to give the dose.`,
              { childId: event.childId, eventId: eventId }
            ).then(() => {
              // Update nextNotificationTime after successfully sending the notification
              const nextNotificationTime = currentTime + 10 * 60 * 1000; // Add 10 minutes
              return db
                .ref(`events/${childSnapshot.key}`)
                .update({ nextNotificationTime, notificationCount: 1 });
            });
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

const checkNextNotificationTime = async () => {
  const currentTime = Date.now();
  const startOfMinute = getStartOfMinute(currentTime);
  const endOfMinute = getEndOfMinute(currentTime); // End of current minute

  // Query for doses that are due within the current minute and have the state "active"
  const snapshot = await db
    .ref("events")
    .orderByChild("nextNotificationTime")
    .startAt(startOfMinute)
    .endAt(endOfMinute)
    .once("value");

  const promises: Promise<any>[] = [];

  snapshot.forEach((childSnapshot) => {
    const event = childSnapshot.val();
    const eventId = childSnapshot.key; // Get the event ID
    if (
      event.state === "active" &&
      event.nextNotificationTime &&
      event.notificationCount <= 5
    ) {
      console.log(
        `Processing dose for childId: ${event.childId} due at ${event.nextScheduledDose}`
      );

      const promise = getChild(event.childId)
        .then((child) => {
          if (!child) {
            throw new Error(`Child not found for ID ${event.childId}`);
          }
          return getUser(child.parentId).then((parent) => {
            if (!parent) {
              throw new Error(`Parent not found for ID ${child.parentId}`);
            }
            const parentPushToken = parent?.pushToken;
            if (!parentPushToken) {
              throw new Error(`No pushToken for parent with ID ${parent.uid}`);
            }
            let notificationBody: string;
            switch (event.notificationCount) {
              case 1:
                notificationBody = `2nd reminder: ${
                  child.childName
                }'s ${capitalizeFirstLetter(event.cycle)} dose is available.`;
                break;
              case 2:
                notificationBody = `3rd reminder: ${
                  child.childName
                }'s ${capitalizeFirstLetter(event.cycle)} dose is available.`;
                break;
              case 3:
                notificationBody = `4th reminder: ${
                  child.childName
                }'s ${capitalizeFirstLetter(event.cycle)} dose is available.`;
                break;
              case 4:
                notificationBody = `${
                  child.childName
                }'s ${capitalizeFirstLetter(
                  event.cycle
                )} episode is now paused. Tap to resume.`;
                break;
                notificationBody = `${
                  child.childName
                } can get the next ${capitalizeFirstLetter(
                  event.cycle
                )} dose now`;
              default:
                break;
            }
            return sendPushNotificationsToUser(parent.uid, notificationBody, {
              childId: event.childId,
              eventId: eventId,
            }).then(() => {
              // Update nextNotificationTime after successfully sending the notification
              let nextNotificationTime: number;
              // event.snoozeInterval set in app on snooze on mark dose
              switch (event.notificationCount) {
                case 1:
                  nextNotificationTime = event.snoozeInterval
                    ? currentTime + event.snoozeInterval * 60 * 1000
                    : currentTime + 10 * 60 * 1000; // add 10 min
                  break;
                case 2:
                  nextNotificationTime = event.snoozeInterval
                    ? currentTime + event.snoozeInterval * 60 * 1000
                    : currentTime + 25 * 60 * 1000; // add 10 min
                  break;
                case 3:
                  nextNotificationTime = event.snoozeInterval
                    ? currentTime + event.snoozeInterval * 60 * 1000
                    : currentTime + 15 * 60 * 1000; // add 25 min
                  break;
                case 4:
                  nextNotificationTime = event.snoozeInterval
                    ? currentTime + event.snoozeInterval * 60 * 1000
                    : currentTime + 15 * 60 * 1000; // add 15 min
                  break;
                default:
                  break;
              }
              const notificationCount = event.notificationCount + 1;

              if (notificationCount === 5) {
                return db.ref(`events/${childSnapshot.key}`).update({
                  state: "paused",
                  nextNotificationTime: null,
                  notificationCount: null,
                  snoozeInterval: null,
                });
              } else {
                return db
                  .ref(`events/${childSnapshot.key}`)
                  .update({ nextNotificationTime, notificationCount });
              }
            });
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

    // Step 5: Code is valid, add caregiver entry
    const caregiverRef = db.ref("caregiver").push();
    await caregiverRef.set({
      caregiver_id: caregiverId,
      create_date: currentTime,
      guardian: false,
      parent_id: inviteData.parentId,
      id: caregiverRef.key,
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
