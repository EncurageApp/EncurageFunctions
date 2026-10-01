const test = require("node:test");
const assert = require("node:assert/strict");
const {normalizeSnoozeInterval} = require("../lib/notificationTiming");

test("only positive numeric snoozes override V1 and V2 reminder defaults", () => {
  for (const value of [5, 10, 15, 30, 0.5, "15", " 30 "]) {
    assert.equal(normalizeSnoozeInterval(value), Number(value));
  }
  for (const value of [
    undefined, null, {__rnfbNull: true}, {}, [], [15], true, false,
    0, -15, NaN, Infinity, -Infinity, "", " ", "invalid", "Infinity", "-15",
  ]) {
    assert.equal(normalizeSnoozeInterval(value), undefined);
  }
});
