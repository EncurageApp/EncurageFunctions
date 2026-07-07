const test = require("node:test");
const assert = require("node:assert/strict");
const {
  dueAtForWorker,
  dueFieldForWorker,
  isWorkerCandidate,
  LIVE_DISCOVERY_LOOKBACK_MS,
  parentIdFromChild,
  parentIdFromEvent,
  shouldRepairParentId,
} = require("../lib/notificationsV2/discovery");

test("uses parentId consistently while supporting legacy child data", () => {
  assert.equal(parentIdFromEvent({parentId: "parent-a"}), "parent-a");
  assert.equal(parentIdFromEvent({parent_id: "legacy-parent"}), null);
  assert.equal(parentIdFromChild({parentId: "parent-a"}), "parent-a");
  assert.equal(parentIdFromChild({parent_id: "parent-b"}), "parent-b");
  assert.equal(parentIdFromChild({}), null);
});

test("repairs parentId only when the stored or actual owner is canary", () => {
  const isCanary = parentId => parentId === "canary-parent";
  assert.equal(
    shouldRepairParentId(null, "regular-parent", isCanary),
    false
  );
  assert.equal(
    shouldRepairParentId(null, "canary-parent", isCanary),
    true
  );
  assert.equal(
    shouldRepairParentId("canary-parent", "regular-parent", isCanary),
    true
  );
  assert.equal(
    shouldRepairParentId("regular-parent", "regular-parent", isCanary),
    false
  );
});

test("uses the scheduled dose for initial discovery", () => {
  assert.equal(dueFieldForWorker("initial"), "nextScheduledDose");
  assert.equal(
    isWorkerCandidate(
      {state: "active", nextScheduledDose: 1_000},
      "initial",
      900,
      1_100
    ),
    true
  );
});

test("uses nextNotificationTime only for reminder state", () => {
  const event = {
    state: "active",
    nextScheduledDose: 1_000,
    nextNotificationTime: 1_100,
    notificationCount: 1,
  };
  assert.equal(isWorkerCandidate(event, "initial", 900, 1_200), false);
  assert.equal(isWorkerCandidate(event, "reminder", 900, 1_200), true);
});

test("includes both boundaries of the live discovery window", () => {
  const now = 1_000_000;
  const rangeStart = now - LIVE_DISCOVERY_LOOKBACK_MS;
  assert.equal(
    isWorkerCandidate(
      {state: "active", nextScheduledDose: rangeStart},
      "initial",
      rangeStart,
      now
    ),
    true
  );
  assert.equal(
    isWorkerCandidate(
      {state: "active", nextScheduledDose: now},
      "initial",
      rangeStart,
      now
    ),
    true
  );
});

test("assigns timestamps older than the live boundary to recovery only", () => {
  const now = 1_000_000;
  const liveStart = now - LIVE_DISCOVERY_LOOKBACK_MS;
  const event = {state: "active", nextScheduledDose: liveStart - 1};

  assert.equal(
    isWorkerCandidate(event, "initial", liveStart, now),
    false
  );
  assert.equal(
    isWorkerCandidate(
      event,
      "initial",
      Number.MIN_SAFE_INTEGER,
      liveStart - 1
    ),
    true
  );
});

test("rejects inactive, future, and null due timestamps", () => {
  assert.equal(
    isWorkerCandidate(
      {state: "paused", nextScheduledDose: 1_000},
      "initial",
      900,
      1_100
    ),
    false
  );
  assert.equal(
    isWorkerCandidate(
      {state: "active", nextScheduledDose: 1_200},
      "initial",
      900,
      1_100
    ),
    false
  );
  assert.equal(
    Number.isNaN(dueAtForWorker({nextScheduledDose: null}, "initial")),
    true
  );
});
