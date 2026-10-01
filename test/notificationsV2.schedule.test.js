const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateNextDoseAfter,
  calculateNextDoseAfterOrNull,
  MINUTE_MS,
  resolveDueStage,
  TERMINAL_SEND_GRACE_MS,
  terminalStageAfterReminder,
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
  assert.equal(TERMINAL_SEND_GRACE_MS, atMinutes(10));
});

test("builds a future terminal task from the final reminder", () => {
  const stage = {
    stage: 3,
    dueAt: atMinutes(525),
    nextNotificationTime: atMinutes(540),
    nextNotificationCount: 4,
    supersededStages: [],
  };

  assert.deepEqual(terminalStageAfterReminder(stage), {
    stage: 4,
    dueAt: atMinutes(540),
    nextNotificationTime: null,
    nextNotificationCount: null,
    supersededStages: [],
  });
  assert.equal(
    terminalStageAfterReminder({...stage, nextNotificationCount: 3}),
    null
  );
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

test("null sentinels preserve every reminder boundary and the terminal deadline", () => {
  const event = {
    nextScheduledDose: atMinutes(480),
    nextNotificationTime: atMinutes(490),
    notificationCount: 1,
  };
  for (const minutes of [489, 490, 499, 500, 524, 525, 539, 540, 2_000]) {
    assert.deepEqual(
      resolveDueStage({...event, snoozeInterval: {__rnfbNull: true}}, atMinutes(minutes)),
      resolveDueStage(event, atMinutes(minutes)),
      `checkpoint at minute ${minutes}`
    );
  }
  const terminal = resolveDueStage(
    {...event, snoozeInterval: {__rnfbNull: true}},
    atMinutes(2_000)
  );
  assert.equal(terminal.stage, 4);
  assert.equal(terminal.dueAt, atMinutes(540));
  assert.doesNotThrow(() => new Date(terminal.dueAt + 30_000).toISOString());
});

test("cleared iOS notification fields do not make a future occurrence due", () => {
  const event = {
    nextScheduledDose: atMinutes(480),
    nextNotificationTime: {__rnfbNull: true},
    notificationCount: {__rnfbNull: true},
    snoozeInterval: {__rnfbNull: true},
  };
  assert.equal(resolveDueStage(event, atMinutes(479)), null);
  const initial = resolveDueStage(event, atMinutes(480));
  assert.equal(initial.stage, 0);
  assert.equal(initial.nextNotificationTime, atMinutes(490));
  const terminal = resolveDueStage(event, atMinutes(541));
  assert.equal(terminal.stage, 4);
  assert.equal(terminal.dueAt, atMinutes(540));
});

test("legacy numeric-string snoozes retain the same remaining checkpoints", () => {
  const event = {
    nextScheduledDose: atMinutes(480),
    nextNotificationTime: atMinutes(505),
    notificationCount: 1,
  };
  for (const minutes of [505, 520, 535, 550]) {
    assert.deepEqual(
      resolveDueStage({...event, snoozeInterval: "15"}, atMinutes(minutes)),
      resolveDueStage({...event, snoozeInterval: 15}, atMinutes(minutes))
    );
  }
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

test("returns null when the next occurrence would be after the end date", () => {
  const start = Date.UTC(2026, 6, 11, 8, 0, 0);
  const prescription = {
    startDate: start,
    endDate: start,
    frequency: {type: "hourly", interval: 4, startDate: start},
  };

  assert.equal(
    calculateNextDoseAfterOrNull(prescription, start, "America/New_York"),
    null
  );
});

test("does not hide invalid schedule errors as an ended prescription", () => {
  assert.throws(
    () => calculateNextDoseAfterOrNull({}, Date.now(), "America/New_York"),
    /Frequency type is required/
  );
});
