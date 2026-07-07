const test = require("node:test");
const assert = require("node:assert/strict");
const {
  notificationV2CanaryUids,
} = require("../lib/notificationsV2/config");

test("includes the expanded six-user canary by default", () => {
  assert.deepEqual(
    [...notificationV2CanaryUids],
    [
      "l2R5cSW1CKfq8CsU002WsQqb3ui1",
      "9xwWrl1ugPht3bRQTGvLlUHJOog2",
      "tJbkGPwW79bruRe8QQgLHzvrdk73",
      "l26xtne9JTSHpywaD12rs1DB8fZ2",
      "rjeHGFSZBFY6zqaQ95E3rBQHZTh1",
      "zvi7h7AsSqSfacqp7tB89IwHny72",
    ]
  );
});
