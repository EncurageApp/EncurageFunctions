const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const clone = (value) => structuredClone(value);

// A deliberately small offline RTDB boundary. Transactions use fresh cloned
// state, snapshots are immutable, and null writes remove fields as RTDB does.
function memoryDatabase(initial) {
  const data = clone(initial);
  const read = (location) => location.split("/").filter(Boolean)
    .reduce((value, key) => value?.[key], data) ?? null;
  const clean = (value) => {
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child != null)
      .map(([key, child]) => [key, clean(child)]));
  };
  const write = (location, value) => {
    const keys = location.split("/").filter(Boolean);
    const last = keys.pop();
    const parent = keys.reduce((node, key) => node[key] ??= {}, data);
    if (value == null) delete parent[last];
    else parent[last] = clean(clone(value));
  };
  const snapshot = (location, value) => ({
    key: location.split("/").pop(),
    ref: ref(location),
    exists: () => value != null,
    val: () => clone(value),
    forEach: (callback) => {
      for (const [key, child] of Object.entries(value || {})) {
        if (callback(snapshot(`${location}/${key}`, child)) === true) break;
      }
    },
  });
  const ref = (location, query = {}) => ({
    orderByChild: (field) => ref(location, {...query, field}),
    equalTo: (equal) => ref(location, {...query, equal}),
    endAt: (end) => ref(location, {...query, end}),
    limitToLast: (limit) => ref(location, {...query, limit}),
    once: async () => {
      let value = clone(read(location));
      if (query.field) {
        let entries = Object.entries(value || {})
          .filter(([, child]) => query.equal === undefined ||
            child[query.field] === query.equal)
          .filter(([, child]) => query.end === undefined ||
            (child[query.field] ?? -Infinity) <= query.end)
          .sort(([leftKey, left], [rightKey, right]) =>
            (left[query.field] ?? -Infinity) -
            (right[query.field] ?? -Infinity) ||
            leftKey.localeCompare(rightKey));
        if (query.limit) entries = entries.slice(-query.limit);
        value = entries.length ? Object.fromEntries(entries) : null;
      }
      return snapshot(location, value);
    },
    set: async (value) => write(location, value),
    remove: async () => write(location, null),
    update: async (patch) => {
      for (const [key, value] of Object.entries(patch)) {
        write(`${location}/${key}`, value);
      }
    },
    transaction: async (updater) => {
      const next = updater(clone(read(location)));
      if (next !== undefined) write(location, next);
      return {
        committed: next !== undefined,
        snapshot: snapshot(location, clone(read(location))),
      };
    },
  });
  return {ref, read: (location) => clone(read(location))};
}

function recoveryHarness({kind = "prescription", event = {}} = {}) {
  const occurrenceAt = Date.now() - 24 * HOUR;
  const collection = kind === "prescription" ? "prescription_events" : "events";
  const eventPath = `${collection}/fixture-event`;
  const db = memoryDatabase({
    children: {"fixture-child": {parentId: "fixture-owner"}},
    users: {"fixture-owner": {timeZone: "UTC"}},
    prescription: {"fixture-prescription": {
      startDate: occurrenceAt,
      timeZone: "UTC",
      frequency: {type: "hourly", interval: 4, startDate: occurrenceAt},
      name: "Synthetic schedule fixture",
      dose: "fixture",
    }},
    [collection]: {"fixture-event": {
      childId: "fixture-child",
      parentId: "fixture-owner",
      prescriptionId: "fixture-prescription",
      state: "active",
      nextScheduledDose: occurrenceAt,
      nextNotificationTime: occurrenceAt + 10 * MINUTE,
      notificationCount: 1,
      snoozeInterval: {__rnfbNull: true},
      ...event,
    }},
  });
  const queued = [];
  const logs = [];
  const pushes = [];
  const passHandler = (_, handler) => handler;
  const mocked = {
    "firebase-admin": {
      app: () => ({database: () => db}),
      messaging: () => ({send: async (message) => pushes.push(message)}),
    },
    "firebase-admin/functions": {getFunctions: () => ({taskQueue: () => ({
      enqueue: async (task, options) => {
        // Match the SDK's date serialization, which raised the original error.
        options.scheduleTime.toISOString();
        if (queued.some((entry) => entry.id === options.id)) {
          throw Object.assign(new Error("Duplicate task"), {
            code: "functions/task-already-exists",
          });
        }
        queued.push({...clone(task), id: options.id});
      },
    })})},
    "firebase-functions/logger": Object.fromEntries(
      ["info", "warn", "error"].map((level) =>
        [level, (...args) => logs.push({level, args})])
    ),
    "firebase-functions/v2/scheduler": {onSchedule: passHandler},
    "firebase-functions/v2/tasks": {onTaskDispatched: passHandler},
    "firebase-functions/v2/database": {
      onValueWritten: passHandler, onValueUpdated: passHandler,
    },
    "p-limit": () => (operation) => operation(),
  };
  const libRoot = path.resolve(__dirname, "../lib");
  const moduleCache = new Map();
  // Keep Firebase mocks local to this module tree, without global require or
  // environment changes. All scheduling and settlement code remains real.
  const load = (filename) => {
    if (moduleCache.has(filename)) return moduleCache.get(filename).exports;
    const isolated = new Module(filename, module);
    isolated.filename = filename;
    isolated.paths = Module._nodeModulePaths(path.dirname(filename));
    moduleCache.set(filename, isolated);
    const actualRequire = Module.createRequire(filename);
    isolated.require = (request) => {
      if (Object.hasOwn(mocked, request)) return mocked[request];
      if (request === "./config") {
        return {notificationV2CanaryUids: new Set(["fixture-owner"])};
      }
      if (request === "./routing") {
        return {
          notificationV2RoutingEnabled: true,
          notificationV2UsesStaticCanaryOnly: false,
          isNotificationV2Owner: (uid) => uid === "fixture-owner",
          getNotificationV2Route: (uid) => ({
            useV2: uid === "fixture-owner", reason: "canary",
          }),
        };
      }
      const resolved = actualRequire.resolve(request);
      return resolved.startsWith(`${libRoot}${path.sep}`) ?
        load(resolved) : actualRequire(request);
    };
    isolated._compile(fs.readFileSync(filename, "utf8"), filename);
    return isolated.exports;
  };
  const functions = load(path.join(libRoot, "notificationsV2/functions.js"));
  return {
    db, eventPath, occurrenceAt, queued, logs, pushes,
    recover: kind === "prescription" ?
      functions.reconcilePrescriptionNotificationsV2Cron :
      functions.reconcileEventNotificationsV2Cron,
    settle: (task = queued[0]) => functions.settleNotificationV2Terminal({data: task}),
  };
}

function assertNoFailedWork(harness) {
  assert.deepEqual(harness.logs.filter(({level}) => level === "error"), []);
  assert.equal(harness.db.read("notification_v2_terminal_jobs"), null);
  assert.equal(harness.db.read("notification_v2_delivery_attempts"), null);
  assert.deepEqual(harness.pushes, []);
}

test("recovery skips a malformed-snooze occurrence once with no stale push", async () => {
  const harness = recoveryHarness();
  await harness.recover();
  assert.equal(harness.queued.length, 1);
  const [task] = harness.queued;
  assert.equal(task.dueAt, harness.occurrenceAt + HOUR);
  assert.equal(task.scheduledFor, task.dueAt + 30_000);
  assert.ok(Number.isFinite(task.scheduledFor));

  await harness.recover();
  assert.equal(harness.queued.length, 1, "deterministic task ID deduplicates recovery");
  await harness.settle();
  const resolved = harness.db.read(harness.eventPath);
  assert.equal(resolved.nextScheduledDose, harness.occurrenceAt + 4 * HOUR);
  assert.equal(resolved._notificationV2LastResolution.status, "skipped");
  assert.equal(resolved.snoozeInterval, undefined);
  assert.equal(resolved._notificationV2PendingDose, undefined);
  const doses = harness.db.read("prescription_doses");
  assert.deepEqual(Object.keys(doses), [`fixture-event_${harness.occurrenceAt}`]);
  assert.equal(Object.values(doses)[0].given, false);
  assert.equal(Object.values(doses)[0].date, harness.occurrenceAt);

  await harness.settle();
  assert.deepEqual(harness.db.read(harness.eventPath), resolved);
  assert.deepEqual(harness.db.read("prescription_doses"), doses);
  assert.equal(harness.db.read(
    "notification_v2_runtime/prescription/fixture-event/lastDeliveryDecision"
  ), "suppressed_late");
  assertNoFailedWork(harness);
});

test("given recorded after recovery wins terminal settlement and its retry", async () => {
  const harness = recoveryHarness();
  await harness.recover();
  assert.equal(harness.queued.length, 1);
  await harness.db.ref("prescription_doses/fixture-given").set({
    prescriptionEventId: "fixture-event",
    date: harness.occurrenceAt,
    given: true,
  });
  await harness.settle();
  const resolved = harness.db.read(harness.eventPath);
  assert.equal(resolved.nextScheduledDose, harness.occurrenceAt + 4 * HOUR);
  assert.equal(resolved._notificationV2LastResolution.status, "given");
  assert.deepEqual(Object.keys(harness.db.read("prescription_doses")), ["fixture-given"]);
  await harness.settle();
  assert.deepEqual(harness.db.read(harness.eventPath), resolved);
  assertNoFailedWork(harness);
});

test("recovery excludes inactive/future events and terminal tasks recheck state", async () => {
  for (const change of [
    {state: "paused"},
    {state: "completed"},
    {
      nextScheduledDose: Date.now() + HOUR,
      nextNotificationTime: Date.now() + HOUR + 10 * MINUTE,
    },
  ]) {
    const excluded = recoveryHarness({event: change});
    await excluded.recover();
    assert.equal(excluded.queued.length, 0);
    assert.equal(excluded.db.read("prescription_doses"), null);
    assertNoFailedWork(excluded);

    const changedAfterQueue = recoveryHarness();
    await changedAfterQueue.recover();
    assert.equal(changedAfterQueue.queued.length, 1);
    await changedAfterQueue.db.ref(changedAfterQueue.eventPath).update(change);
    const beforeSettlement = changedAfterQueue.db.read(changedAfterQueue.eventPath);
    await changedAfterQueue.settle();
    assert.deepEqual(changedAfterQueue.db.read(changedAfterQueue.eventPath), beforeSettlement);
    assert.equal(changedAfterQueue.db.read("prescription_doses"), null);
    assertNoFailedWork(changedAfterQueue);
  }
});

test("as-needed stale malformed-snooze recovery pauses once without a late push", async () => {
  const harness = recoveryHarness({kind: "as_needed"});
  await harness.recover();
  assert.equal(harness.queued.length, 1);
  assert.equal(harness.queued[0].dueAt, harness.occurrenceAt + HOUR);
  await harness.settle();
  const resolved = harness.db.read(harness.eventPath);
  assert.equal(resolved.state, "paused");
  assert.equal(resolved._notificationV2LastResolution.status, "skipped");
  assert.equal(resolved.snoozeInterval, undefined);
  await harness.settle();
  assert.deepEqual(harness.db.read(harness.eventPath), resolved);
  assertNoFailedWork(harness);
});
