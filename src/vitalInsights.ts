import * as v1 from "firebase-functions/v1";

export type VitalInsightsVitalKey =
  | "heartRate"
  | "bloodPressure"
  | "respiratoryRate"
  | "oxygenSaturation"
  | "bloodGlucoseLevel"
  | "peakExpiratoryFlowRate";

export type VitalInsightsPreset = "1W" | "4W" | "12W" | "CUSTOM";

export type VitalInsightsRequest = {
  childId: string;
  vitalKey: VitalInsightsVitalKey;
  startAt: number;
  endAt: number;
  preset: VitalInsightsPreset;
};

type VitalInsightsPoint = {
  timestamp: number;
  value: number;
};

type VitalInsightsSeries = {
  key: string;
  label: string;
  color: string;
  unit: string;
  points: VitalInsightsPoint[];
};

type VitalInsightsStat = {
  key:
    | "latest"
    | "highest"
    | "lowest"
    | "totalReadings"
    | "latestBp"
    | "highestSys"
    | "lowestDia";
  value: string;
};

export type VitalInsightsResponse = {
  vitalKey: VitalInsightsVitalKey;
  title: string;
  unit: string;
  range: {
    startAt: number;
    endAt: number;
    preset: VitalInsightsPreset;
  };
  series: VitalInsightsSeries[];
  stats: VitalInsightsStat[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = DAY_MS * 84;
const ALLOWED_VITAL_KEYS: VitalInsightsVitalKey[] = [
  "heartRate",
  "bloodPressure",
  "respiratoryRate",
  "oxygenSaturation",
  "bloodGlucoseLevel",
  "peakExpiratoryFlowRate",
];

const HEART_RATE_WEEKLY_BASELINES = [
  92, 94, 91, 96, 89, 93, 95, 90, 97, 94, 88, 92,
];

const BLOOD_PRESSURE_SYS_WEEKLY_BASELINES = [
  88, 91, 86, 90, 84, 89, 92, 87, 93, 90, 85, 89,
];

const BLOOD_PRESSURE_DIA_WEEKLY_BASELINES = [
  116, 121, 111, 118, 109, 114, 123, 112, 127, 119, 108, 115,
];

const hashString = (value: string): number => {
  let hash = 0;

  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 2147483647;
  }

  return hash || 1;
};

const createRandom = (seed: number) => {
  let state = seed || 1;

  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const validateRequest = (data: any): VitalInsightsRequest => {
  const {childId, vitalKey, startAt, endAt, preset} = data ?? {};

  if (typeof childId !== "string" || !childId.trim()) {
    throw new v1.https.HttpsError("invalid-argument", "childId is required.");
  }

  if (!ALLOWED_VITAL_KEYS.includes(vitalKey)) {
    throw new v1.https.HttpsError("invalid-argument", "Unsupported vital key.");
  }

  if (
    typeof startAt !== "number" ||
    typeof endAt !== "number" ||
    !Number.isFinite(startAt) ||
    !Number.isFinite(endAt)
  ) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "startAt and endAt must be valid numbers."
    );
  }

  if (startAt >= endAt) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "startAt must be before endAt."
    );
  }

  if (endAt - startAt > MAX_RANGE_MS) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "The selected range cannot exceed 12 weeks."
    );
  }

  if (
    preset !== "1W" &&
    preset !== "4W" &&
    preset !== "12W" &&
    preset !== "CUSTOM"
  ) {
    throw new v1.https.HttpsError("invalid-argument", "Unsupported preset.");
  }

  return {
    childId,
    vitalKey,
    startAt,
    endAt,
    preset,
  };
};

const buildTimestamps = (
  startAt: number,
  endAt: number,
  random: () => number
): number[] => {
  const timestamps: number[] = [];
  const durationMs = endAt - startAt;
  const durationDays = Math.max(1, Math.ceil(durationMs / DAY_MS));
  const isSingleDay = durationMs <= DAY_MS;

  if (isSingleDay) {
    const count = 7 + Math.floor(random() * 5);
    const interval = durationMs / (count + 1);

    for (let i = 1; i <= count; i += 1) {
      const jitter = (random() - 0.5) * interval * 0.45;
      const timestamp = clamp(
        Math.round(startAt + interval * i + jitter),
        startAt,
        endAt
      );
      timestamps.push(timestamp);
    }

    return timestamps.sort((a, b) => a - b);
  }

  for (let dayIndex = 0; dayIndex < durationDays; dayIndex += 1) {
    const dayStart = startAt + dayIndex * DAY_MS;
    const dayEnd = Math.min(dayStart + DAY_MS - 1, endAt);

    if (random() < 0.12) {
      continue;
    }

    const entriesToday = 1 + (random() > 0.62 ? 1 : 0) + (random() > 0.9 ? 1 : 0);

    for (let i = 0; i < entriesToday; i += 1) {
      const hourWindows = [8, 12, 17, 21];
      const baseHour = hourWindows[(dayIndex + i) % hourWindows.length];
      const hourOffset = (random() - 0.5) * 2.5;
      const minute = Math.floor(random() * 60);
      const timestamp = new Date(dayStart);
      timestamp.setHours(
        clamp(Math.round(baseHour + hourOffset), 0, 23),
        minute,
        0,
        0
      );

      const nextValue = clamp(timestamp.getTime(), dayStart, dayEnd);

      if (nextValue >= startAt && nextValue <= endAt) {
        timestamps.push(nextValue);
      }
    }
  }

  return timestamps.sort((a, b) => a - b);
};

const buildSeriesPoints = (
  timestamps: number[],
  random: () => number,
  options: {
    min: number;
    max: number;
    baseline: number;
    wave: number;
    jitter: number;
  }
): VitalInsightsPoint[] =>
  timestamps.map((timestamp, index) => {
    const curve =
      Math.sin(index / 3.2) * options.wave +
      Math.cos(index / 6.4) * (options.wave / 2);
    const noise = (random() - 0.5) * options.jitter;
    const value = clamp(
      Math.round(options.baseline + curve + noise),
      options.min,
      options.max
    );

    return {
      timestamp,
      value,
    };
  });

const buildHeartRatePoints = (
  timestamps: number[],
  random: () => number,
  rangeStartAt: number
): VitalInsightsPoint[] =>
  timestamps.map((timestamp) => {
    const weekIndex = Math.min(
      HEART_RATE_WEEKLY_BASELINES.length - 1,
      Math.max(0, Math.floor((timestamp - rangeStartAt) / DAY_MS / 7))
    );
    const weeklyBaseline = HEART_RATE_WEEKLY_BASELINES[weekIndex];
    const dayPhase = ((timestamp - rangeStartAt) / DAY_MS) % 7;
    const dailyDrift = Math.sin(dayPhase / 1.15) * 2.4;
    const noise = (random() - 0.5) * 5;

    return {
      timestamp,
      value: clamp(Math.round(weeklyBaseline + dailyDrift + noise), 82, 108),
    };
  });

const buildBloodPressurePoints = (
  timestamps: number[],
  random: () => number,
  rangeStartAt: number,
  weeklyBaselines: number[],
  min: number,
  max: number,
  dailyDriftStrength: number,
  jitter: number
): VitalInsightsPoint[] =>
  timestamps.map((timestamp) => {
    const weekIndex = Math.min(
      weeklyBaselines.length - 1,
      Math.max(0, Math.floor((timestamp - rangeStartAt) / DAY_MS / 7))
    );
    const baseline = weeklyBaselines[weekIndex];
    const dayPhase = ((timestamp - rangeStartAt) / DAY_MS) % 7;
    const dailyDrift = Math.cos(dayPhase / 1.3) * dailyDriftStrength;
    const noise = (random() - 0.5) * jitter;

    return {
      timestamp,
      value: clamp(Math.round(baseline + dailyDrift + noise), min, max),
    };
  });

const getStatsForSingleSeries = (unit: string, points: VitalInsightsPoint[]) => {
  const sortedByValue = [...points].sort((a, b) => a.value - b.value);
  const latest = points[points.length - 1];
  const lowest = sortedByValue[0];
  const highest = sortedByValue[sortedByValue.length - 1];

  return [
    {key: "latest" as const, value: `${latest.value} ${unit}`},
    {key: "highest" as const, value: `${highest.value} ${unit}`},
    {key: "lowest" as const, value: `${lowest.value} ${unit}`},
    {key: "totalReadings" as const, value: String(points.length)},
  ];
};

const getStatsForBloodPressure = (
  systolic: VitalInsightsPoint[],
  diastolic: VitalInsightsPoint[]
) => {
  const highestSys = [...systolic].sort((a, b) => b.value - a.value)[0];
  const lowestDia = [...diastolic].sort((a, b) => a.value - b.value)[0];
  const latestSys = systolic[systolic.length - 1];
  const latestDia = diastolic[diastolic.length - 1];

  return [
    {
      key: "latestBp" as const,
      value: `${latestSys.value}/${latestDia.value} mmHg`,
    },
    {key: "highestSys" as const, value: `${highestSys.value} mmHg`},
    {key: "lowestDia" as const, value: `${lowestDia.value} mmHg`},
    {key: "totalReadings" as const, value: String(systolic.length)},
  ];
};

export const getVitalInsightsPayload = (
  rawData: any
): VitalInsightsResponse => {
  const request = validateRequest(rawData);
  const seed = hashString(
    `${request.childId}:${request.vitalKey}:${request.startAt}:${request.endAt}:${request.preset}`
  );
  const random = createRandom(seed);
  const timestamps = buildTimestamps(request.startAt, request.endAt, random);

  let series: VitalInsightsSeries[] = [];
  let unit = "";
  let title = "";

  switch (request.vitalKey) {
    case "heartRate":
      unit = "bpm";
      title = "Heart Rate (Pulse)";
      series = [
        {
          key: "heartRate",
          label: "Heart Rate",
          color: "#2E9593",
          unit,
          points: buildHeartRatePoints(timestamps, random, request.startAt),
        },
      ];
      break;
    case "bloodPressure":
      unit = "mmHg";
      title = "Blood Pressure";
      series = [
        {
          key: "sys",
          label: "SYS",
          color: "#D33030",
          unit,
          points: buildBloodPressurePoints(
            timestamps,
            random,
            request.startAt,
            BLOOD_PRESSURE_SYS_WEEKLY_BASELINES,
            78,
            96,
            3.5,
            6
          ),
        },
        {
          key: "dia",
          label: "DIA",
          color: "#3448F0",
          unit,
          points: buildBloodPressurePoints(
            timestamps,
            random,
            request.startAt,
            BLOOD_PRESSURE_DIA_WEEKLY_BASELINES,
            102,
            134,
            4.5,
            8
          ),
        },
      ];
      break;
    case "respiratoryRate":
      unit = "breaths/min";
      title = "Respiratory Rate";
      series = [
        {
          key: "respiratoryRate",
          label: "Respiratory Rate",
          color: "#CA8A09",
          unit,
          points: buildSeriesPoints(timestamps, random, {
            min: 14,
            max: 32,
            baseline: 22,
            wave: 4,
            jitter: 4,
          }),
        },
      ];
      break;
    case "oxygenSaturation":
      unit = "%";
      title = "Oxygen Saturation";
      series = [
        {
          key: "oxygenSaturation",
          label: "Oxygen Saturation",
          color: "#3BA8A7",
          unit,
          points: buildSeriesPoints(timestamps, random, {
            min: 91,
            max: 100,
            baseline: 97,
            wave: 1.8,
            jitter: 1.5,
          }),
        },
      ];
      break;
    case "bloodGlucoseLevel":
      unit = "mg/dL";
      title = "Blood Glucose Level";
      series = [
        {
          key: "bloodGlucoseLevel",
          label: "Blood Glucose",
          color: "#D33030",
          unit,
          points: buildSeriesPoints(timestamps, random, {
            min: 72,
            max: 168,
            baseline: 106,
            wave: 16,
            jitter: 14,
          }),
        },
      ];
      break;
    case "peakExpiratoryFlowRate":
      unit = "L/min";
      title = "Peak Expiratory Flow Rate";
      series = [
        {
          key: "peakExpiratoryFlowRate",
          label: "Peak Flow",
          color: "#4E807F",
          unit,
          points: buildSeriesPoints(timestamps, random, {
            min: 140,
            max: 420,
            baseline: 275,
            wave: 48,
            jitter: 28,
          }),
        },
      ];
      break;
  }

  const stats =
    request.vitalKey === "bloodPressure"
      ? getStatsForBloodPressure(series[0].points, series[1].points)
      : getStatsForSingleSeries(unit, series[0].points);

  return {
    vitalKey: request.vitalKey,
    title,
    unit,
    range: {
      startAt: request.startAt,
      endAt: request.endAt,
      preset: request.preset,
    },
    series,
    stats,
  };
};
