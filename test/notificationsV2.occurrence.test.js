const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyGivenAsNeededOccurrence,
  applyGivenPrescriptionOccurrence,
  findNewlyGivenAsNeededOccurrence,
  occurrenceKey,
  prescriptionDoseKey,
  terminalSettlementAt,
  TERMINAL_SETTLEMENT_MS,
} = require("../lib/notificationsV2/occurrence");

test("uses deterministic occurrence and prescription dose keys", () => {
  assert.equal(
    occurrenceKey("prescription", "event-1", 1234),
    "prescription:event-1:1234"
  );
  assert.equal(prescriptionDoseKey("event-1", 1234), "event-1_1234");
});

test("adds a thirty-second terminal settlement period", () => {
  assert.equal(TERMINAL_SETTLEMENT_MS, 30_000);
  assert.equal(terminalSettlementAt(60_000), 90_000);
});

test("recovers as-needed occurrence time from the pre-given dose", () => {
  const result = findNewlyGivenAsNeededOccurrence(
    {
      nextScheduledDose: 1000,
      dosageGiven: [{given: false, timeAvailable: 1000, whatGiven: "Ibuprofen"}],
    },
    {
      nextScheduledDose: 2000,
      dosageGiven: [
        {given: true, timeGiven: 1100, whatGiven: "Ibuprofen"},
        {given: false, timeAvailable: 2000, whatGiven: "Ibuprofen"},
      ],
    }
  );
  assert.deepEqual(result, {
    occurrenceAt: 1000,
    dose: {given: true, timeGiven: 1100, whatGiven: "Ibuprofen"},
    index: 0,
  });
});

test("ignores event updates that do not newly mark a dose given", () => {
  assert.equal(
    findNewlyGivenAsNeededOccurrence(
      {dosageGiven: [{given: true, timeGiven: 1000}]},
      {dosageGiven: [{given: true, timeGiven: 1000}], notes: "updated"}
    ),
    null
  );
});

test("advances a prescription occurrence only while it is current", () => {
  const result = applyGivenPrescriptionOccurrence(
    {
      state: "active",
      nextScheduledDose: 1000,
      nextNotificationTime: 1100,
      notificationCount: 4,
    },
    1000,
    "given-dose",
    2000,
    1500
  );
  assert.equal(result.nextScheduledDose, 2000);
  assert.equal(result._notificationV2LastResolution.status, "given");
  assert.equal(result.nextNotificationTime, null);

  assert.equal(
    applyGivenPrescriptionOccurrence(
      {state: "active", nextScheduledDose: 3000},
      1000,
      "given-dose",
      2000,
      1500
    ),
    undefined
  );
});

test("given corrects skipped without advancing the next occurrence twice", () => {
  const result = applyGivenPrescriptionOccurrence(
    {
      state: "active",
      nextScheduledDose: 2000,
      _notificationV2LastResolution: {
        occurrenceAt: 1000,
        status: "skipped",
      },
    },
    1000,
    "given-dose",
    3000,
    1600
  );
  assert.equal(result.nextScheduledDose, 2000);
  assert.equal(result._notificationV2LastResolution.status, "given");
});

test("given completes a prescription when there is no next occurrence", () => {
  const result = applyGivenPrescriptionOccurrence(
    {
      state: "active",
      nextScheduledDose: 1000,
      nextNotificationTime: 1100,
      notificationCount: 4,
    },
    1000,
    "given-dose",
    null,
    1500
  );

  assert.equal(result.state, "completed");
  assert.equal(result.nextScheduledDose, null);
  assert.equal(result._notificationV2LastResolution.status, "given");
});

test("as-needed given wins a simultaneous terminal pause", () => {
  const result = applyGivenAsNeededOccurrence(
    {
      state: "paused",
      nextScheduledDose: 2000,
      _notificationV2LastResolution: {
        occurrenceAt: 1000,
        status: "skipped",
      },
    },
    "event-1",
    1000,
    true,
    1600
  );
  assert.equal(result.state, "active");
  assert.equal(result.nextScheduledDose, 2000);
  assert.equal(result._notificationV2LastResolution.status, "given");
});
