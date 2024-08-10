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

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// export const helloWorld = v1.https.onRequest((request, response) => {
//   logger.info('Hello logs!', { structuredData: true });
//   response.send('Hello from Firebase!');
// });

// export const newChildAdded = v1.database
//   .ref("children/{childId}")
//   .onCreate((snapshot, context) => {
//     const child = snapshot.val();
//     // get parent from child
//     return getUser(child?.parentId).then((parent) => {
//       if (!parent) {
//         return Promise.reject(
//           new Error(
//             `Could not locate the parent user with an ID of ${child?.parentId}. Cannot send notification.`
//           )
//         );
//       }
//       const parentPushToken = parent?.pushToken;
//       logger.info("parentPushToken", parentPushToken);

//       if (!parentPushToken) {
//         return Promise.reject(new Error(`no pushToken for ${parent.uid}`));
//       }
//       // send message
//       return sendPushNotificationsToUser(
//         parent.uid,
//         getNotificationPayload({
//           body: `${parent.firstName}, You added a child!`,
//         })
//       );
//     });
//   });

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
  const db = admin.database();
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

  snapshot.forEach((childSnapshot) => {
    const event = childSnapshot.val();
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
              )} dose now. Tap to give the dose.`
            ).then(() => {
              // Update nextNotificationTime after successfully sending the notification
              const nextNotificationTime = currentTime + 10 * 60 * 1000; // Add 10 minutes
              const notificationCount = 1;
              return db
                .ref(`events/${childSnapshot.key}`)
                .update({ nextNotificationTime, notificationCount });
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
  const db = admin.database();
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
            let notificationNumber: string;
            switch (event.notificationCount) {
              case 1:
                notificationNumber = "2nd reminder";
                break;
              case 2:
                notificationNumber = "3rd reminder";
                break;
              case 3:
                notificationNumber = "4th reminder";
                break;
              case 4:
                notificationNumber = "final reminder!, episode is now paused";
                break;
              default:
                break;
            }
            return sendPushNotificationsToUser(
              parent.uid,
              `${child.childName} can get the next ${capitalizeFirstLetter(
                event.cycle
              )} dose now, ${notificationNumber}`
            ).then(() => {
              // Update nextNotificationTime after successfully sending the notification
              const nextNotificationTime = currentTime + 10 * 60 * 1000; // Add 10 minutes
              const notificationCount = event.notificationCount + 1;

              if (notificationCount === 5) {
                return db.ref(`events/${childSnapshot.key}`).update({
                  state: "paused",
                  nextNotificationTime: null,
                  notificationCount: null,
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

function sendPushNotificationsToUser(userId, payload) {
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

      const message = {
        token: recipientPushToken,
        notification: {
          title: "Encurage",
          body: payload,
        },
      };
      return admin.messaging().send(message);
    })
    .then((response: any) => {
      if (response?.failureCount > 0) {
        const failureMessages = response?.results
          .filter((result) => result.error)
          .map((result) => result.error)
          .join(", ");
        console.error("sendPushNotificationsToUser error: ", failureMessages);
      }
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
