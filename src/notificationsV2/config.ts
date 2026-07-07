const DEFAULT_CANARY_UIDS = [
  "l2R5cSW1CKfq8CsU002WsQqb3ui1",
  "9xwWrl1ugPht3bRQTGvLlUHJOog2",
  "tJbkGPwW79bruRe8QQgLHzvrdk73",
  "l26xtne9JTSHpywaD12rs1DB8fZ2",
  "rjeHGFSZBFY6zqaQ95E3rBQHZTh1",
  "zvi7h7AsSqSfacqp7tB89IwHny72",
];

const configuredUids = process.env.NOTIFICATION_V2_CANARY_UIDS;

export const notificationV2CanaryUids = new Set(
  (configuredUids ? configuredUids.split(",") : DEFAULT_CANARY_UIDS)
    .map((uid) => uid.trim())
    .filter(Boolean)
);

export const notificationV2CanaryEnabled =
  process.env.NOTIFICATION_V2_CANARY_ENABLED === "true";
