const test = require("node:test");
const assert = require("node:assert/strict");

const clearRoutingModules = () => {
  [
    "../lib/notificationsV2/routing",
    "../lib/notificationsV2/config",
  ].forEach((path) => {
    delete require.cache[require.resolve(path)];
  });
};

const loadRouting = (env = {}) => {
  const previous = {
    NOTIFICATION_V2_CANARY_ENABLED:
      process.env.NOTIFICATION_V2_CANARY_ENABLED,
    NOTIFICATION_V2_CANARY_UIDS: process.env.NOTIFICATION_V2_CANARY_UIDS,
    NOTIFICATION_V2_KILL_SWITCH: process.env.NOTIFICATION_V2_KILL_SWITCH,
    NOTIFICATION_V2_ROLLOUT_MODE: process.env.NOTIFICATION_V2_ROLLOUT_MODE,
    NOTIFICATION_V2_ROLLOUT_PERCENT:
      process.env.NOTIFICATION_V2_ROLLOUT_PERCENT,
  };
  Object.keys(previous).forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);
  clearRoutingModules();
  const routing = require("../lib/notificationsV2/routing");
  return {
    routing,
    restore: () => {
      Object.keys(previous).forEach((key) => delete process.env[key]);
      Object.entries(previous).forEach(([key, value]) => {
        if (value !== undefined) process.env[key] = value;
      });
      clearRoutingModules();
    },
  };
};

test("routes no users when V2 is disabled", () => {
  const {routing, restore} = loadRouting();
  try {
    assert.equal(routing.isNotificationV2Owner("parent-a"), false);
    assert.deepEqual(routing.getNotificationV2Route("parent-a"), {
      useV2: false,
      reason: "disabled",
    });
  } finally {
    restore();
  }
});

test("routes explicit canary users when enabled", () => {
  const {routing, restore} = loadRouting({
    NOTIFICATION_V2_CANARY_ENABLED: "true",
    NOTIFICATION_V2_CANARY_UIDS: "parent-a",
  });
  try {
    assert.equal(routing.isNotificationV2Owner("parent-a"), true);
    assert.equal(routing.getNotificationV2Route("parent-a").reason, "canary");
    assert.equal(routing.isNotificationV2Owner("parent-b"), false);
  } finally {
    restore();
  }
});

test("kill switch overrides canary and rollout", () => {
  const {routing, restore} = loadRouting({
    NOTIFICATION_V2_CANARY_ENABLED: "true",
    NOTIFICATION_V2_CANARY_UIDS: "parent-a",
    NOTIFICATION_V2_KILL_SWITCH: "true",
    NOTIFICATION_V2_ROLLOUT_MODE: "all",
  });
  try {
    assert.deepEqual(routing.getNotificationV2Route("parent-a"), {
      useV2: false,
      reason: "kill_switch",
    });
  } finally {
    restore();
  }
});

test("all mode routes non-canary users", () => {
  const {routing, restore} = loadRouting({
    NOTIFICATION_V2_CANARY_ENABLED: "true",
    NOTIFICATION_V2_ROLLOUT_MODE: "all",
  });
  try {
    assert.deepEqual(routing.getNotificationV2Route("parent-b"), {
      useV2: true,
      reason: "all",
    });
  } finally {
    restore();
  }
});

test("percentage mode is stable by parent id", () => {
  const {routing, restore} = loadRouting({
    NOTIFICATION_V2_CANARY_ENABLED: "true",
    NOTIFICATION_V2_ROLLOUT_MODE: "percentage",
    NOTIFICATION_V2_ROLLOUT_PERCENT: "25",
  });
  try {
    const first = routing.getNotificationV2Route("parent-stable");
    const second = routing.getNotificationV2Route("parent-stable");
    assert.deepEqual(first, second);
    assert.equal(Number.isInteger(first.bucket), true);
    assert.equal(first.bucket >= 0 && first.bucket < 10_000, true);
  } finally {
    restore();
  }
});
