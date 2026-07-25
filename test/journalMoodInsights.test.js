const test = require("node:test");
const assert = require("node:assert/strict");
const moment = require("moment-timezone");
const {
  buildMoodInsightsFromRecords,
} = require("../lib/journalInsights");

const timeZone = "America/New_York";
const at = (value) => moment.tz(value, timeZone).valueOf();
const entry = (dateTime, moods, specialNotes = {}) => ({
  data: {
    dateTime,
    subjects: {
      emotionalWellbeingMood: {
        emotionalWellBeing: moods,
        ...specialNotes,
      },
    },
  },
});

test("mood insights preserve selections, notes, percentages, and DST-safe streaks", () => {
  const result = buildMoodInsightsFromRecords(
    [
      entry(at("2026-03-07 08:00"), ["happy", "worried"], {
        Newtreatment: "Started treatment A",
      }),
      entry(at("2026-03-07 19:00"), ["happy"], {
        Changeofdose: "Dose increased",
      }),
      entry(at("2026-03-08 09:00"), ["happy", "curious"]),
      entry(at("2026-03-09 11:00"), ["happy", "curious"]),
    ],
    timeZone
  );

  assert.equal(result.days.length, 3);
  assert.deepEqual(result.days[0].moods, ["happy", "worried", "happy"]);
  assert.deepEqual(result.days[0].specialNotes, [
    {type: "Newtreatment", text: "Started treatment A"},
    {type: "Changeofdose", text: "Dose increased"},
  ]);
  assert.equal(result.totalSelections, 7);
  assert.deepEqual(result.mostFrequent, {moodKeys: ["happy"], count: 4});
  assert.deepEqual(result.longestStreak, {moodKeys: ["happy"], days: 3});
  assert.equal(
    result.distribution.find((item) => item.moodKey === "happy").percentage,
    (4 / 7) * 100
  );
});

test("mood insights return all frequency and streak ties", () => {
  const result = buildMoodInsightsFromRecords(
    [
      entry(at("2026-03-10 08:00"), ["happy", "worried"]),
      entry(at("2026-03-11 08:00"), ["happy", "worried"]),
    ],
    timeZone
  );

  assert.deepEqual(result.mostFrequent, {
    moodKeys: ["happy", "worried"],
    count: 2,
  });
  assert.deepEqual(result.longestStreak, {
    moodKeys: ["happy", "worried"],
    days: 2,
  });
});

test("mood insights group UTC timestamps by the supplied device timezone", () => {
  const result = buildMoodInsightsFromRecords(
    [
      entry(Date.parse("2026-03-12T01:00:00.000Z"), ["happy"]),
      entry(Date.parse("2026-03-12T03:00:00.000Z"), ["worried"]),
    ],
    timeZone
  );

  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].dateKey, "2026-03-11");
  assert.deepEqual(result.days[0].moods, ["happy", "worried"]);
});
