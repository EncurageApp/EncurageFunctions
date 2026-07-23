const test = require("node:test");
const assert = require("node:assert/strict");
const moment = require("moment-timezone");
const {
  buildMedicationInsightsResponse,
} = require("../lib/medicationInsights");

const timeZone = "America/New_York";
const at = (value) => moment.tz(value, timeZone).valueOf();
const request = {
  childId: "child",
  prescriptionEventId: "event",
  startAt: at("2026-07-15 00:00"),
  endAt: at("2026-07-16 23:59"),
  preset: "30D",
};
const event = {
  childId: "child",
  eventId: "event",
  prescriptionId: "prescription",
  state: "active",
  nextScheduledDose: at("2026-07-16 20:00"),
};
const prescription = {
  name: "Medication",
  dose: {dose: "5", unit: "mg"},
  frequency: {type: "daily", interval: 4},
  shapeAndColor: "Round, white tablet",
  conditionReason: "Migraine prevention",
  notes: "Take with food",
  startDate: at("2026-07-01 00:00"),
  timeZone,
};

test("medication adherence excludes future doses and counts manual doses", () => {
  const response = buildMedicationInsightsResponse({
    request,
    event,
    prescription,
    now: at("2026-07-16 17:00"),
    doses: [
      {date: at("2026-07-15 08:00"), given: true, timeGiven: at("2026-07-15 08:02")},
      {date: at("2026-07-15 12:00"), given: true, timeGiven: at("2026-07-15 12:02")},
      {date: at("2026-07-15 16:00"), given: false},
      {date: at("2026-07-15 18:00"), given: true, timeGiven: at("2026-07-15 18:00")},
      {date: at("2026-07-16 08:00"), given: true, timeGiven: at("2026-07-16 08:00")},
      {date: at("2026-07-16 20:00"), given: false},
    ],
  });

  assert.deepEqual(
    {
      scheduled: response.days[0].scheduledDoses,
      given: response.days[0].givenDoses,
      state: response.days[0].state,
    },
    {scheduled: 4, given: 3, state: "partial"}
  );
  assert.equal(response.days[1].scheduledDoses, 1);
  assert.equal(response.days[1].futureDoses, 1);
  assert.equal(response.doseHistory.length, 5);
  assert.deepEqual(
    response.doseHistory.find(
      (dose) => dose.scheduledDate === at("2026-07-15 16:00")
    ),
    {scheduledDate: at("2026-07-15 16:00"), given: false}
  );
  assert.equal(
    response.doseHistory.some(
      (dose) => dose.scheduledDate === at("2026-07-16 20:00")
    ),
    false
  );
  assert.deepEqual(
    {
      shapeAndColor: response.schedule.shapeAndColor,
      conditionReason: response.schedule.conditionReason,
      notes: response.schedule.notes,
    },
    {
      shapeAndColor: "Round, white tablet",
      conditionReason: "Migraine prevention",
      notes: "Take with food",
    }
  );
});

test("future-only days use the no-scheduled-yet tooltip", () => {
  const response = buildMedicationInsightsResponse({
    request: {...request, startAt: at("2026-07-16 00:00")},
    event,
    prescription,
    doses: [],
    now: at("2026-07-16 07:00"),
  });
  assert.equal(response.days[0].scheduledDoses, 0);
  assert.equal(response.days[0].tooltipKind, "no-scheduled-yet");
  assert.equal(response.unavailableReason, "no-dose-history");
});
