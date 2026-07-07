const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateNextDoseAfter,
  MINUTE_MS,
  resolveDueStage,
  TERMINAL_SEND_GRACE_MS,
} = require("../lib/notificationsV2/schedule");

const atMinutes = (minutes) => minutes * MINUTE_MS;

test("keeps the first reminder anchored to the scheduled dose", () => {
  const result = resolveDueStage({nextScheduledDose: atMinutes(480)}, atMinutes(481));
  assert.deepEqual(result, {
    stage: 0,
    dueAt: atMinutes(480),
    nextNotificationTime: atMinutes(490),
    nextNotificationCount: 1,
    supersededStages: [],
  });
});

test("selects only the latest applicable checkpoint during catch-up", () => {
  const result = resolveDueStage({nextScheduledDose: atMinutes(480)}, atMinutes(510));
  assert.deepEqual(result, {
    stage: 2,
    dueAt: atMinutes(500),
    nextNotificationTime: atMinutes(525),
    nextNotificationCount: 3,
    supersededStages: [0, 1],
  });
});

test("identifies the terminal checkpoint after the one-hour window", () => {
  const result = resolveDueStage({nextScheduledDose: atMinutes(480)}, atMinutes(541));
  assert.equal(result.stage, 4);
  assert.equal(result.dueAt, atMinutes(540));
  assert.equal(result.nextNotificationTime, null);
  assert.equal(TERMINAL_SEND_GRACE_MS, atMinutes(5));
});

test("preserves snooze intervals for every remaining checkpoint", () => {
  const result = resolveDueStage(
    {
      nextScheduledDose: atMinutes(480),
      nextNotificationTime: atMinutes(505),
      notificationCount: 1,
      snoozeInterval: 15,
    },
    atMinutes(530)
  );
  assert.deepEqual(result, {
    stage: 2,
    dueAt: atMinutes(520),
    nextNotificationTime: atMinutes(535),
    nextNotificationCount: 3,
    supersededStages: [1],
  });
});

test("calculates the next hourly occurrence from the previous schedule", () => {
  const start = Date.UTC(2026, 5, 29, 8, 0, 0);
  const prescription = {
    startDate: start,
    frequency: {type: "hourly", interval: 4, startDate: start},
  };
  assert.equal(
    calculateNextDoseAfter(prescription, start, "America/New_York"),
    start + 4 * 60 * MINUTE_MS
  );
});

