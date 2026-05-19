import * as admin from "firebase-admin";
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

type TrackingRecord = {
  id?: string;
  childId?: string;
  trackingType?: string;
  category?: string;
  data?: {
    value?: string | number;
    sysValue?: string | number;
    diaValue?: string | number;
    dateTime?: string | number;
  };
};

type VitalConfig = {
  title: string;
  unit: string;
  categoryKeys: string[];
  series: Omit<VitalInsightsSeries, "points">[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = DAY_MS * 84;

// One config object drives both the database lookup and the response shape.
// categoryKeys includes current camelCase values and older display-name values
// because the RN app has saved both formats over time.
const VITAL_CONFIG: Record<VitalInsightsVitalKey, VitalConfig> = {
  heartRate: {
    title: "Heart Rate (Pulse)",
    unit: "bpm",
    categoryKeys: ["heartRate", "Heart Rate (Pulse)"],
    series: [
      {
        key: "heartRate",
        label: "Heart Rate",
        color: "#2E9593",
        unit: "bpm",
      },
    ],
  },
  bloodPressure: {
    title: "Blood Pressure",
    unit: "mmHg",
    categoryKeys: ["bloodPressure", "Blood Pressure"],
    series: [
      {
        key: "sys",
        label: "SYS",
        color: "#D33030",
        unit: "mmHg",
      },
      {
        key: "dia",
        label: "DIA",
        color: "#3448F0",
        unit: "mmHg",
      },
    ],
  },
  respiratoryRate: {
    title: "Respiratory Rate",
    unit: "breaths/min",
    categoryKeys: ["respiratoryRate", "Respiratory Rate"],
    series: [
      {
        key: "respiratoryRate",
        label: "Respiratory Rate",
        color: "#CA8A09",
        unit: "breaths/min",
      },
    ],
  },
  oxygenSaturation: {
    title: "Oxygen Saturation",
    unit: "%",
    categoryKeys: ["oxygenSaturation", "Oxygen Saturation"],
    series: [
      {
        key: "oxygenSaturation",
        label: "Oxygen Saturation",
        color: "#3BA8A7",
        unit: "%",
      },
    ],
  },
  bloodGlucoseLevel: {
    title: "Blood Glucose Level",
    unit: "mg/dL",
    categoryKeys: ["bloodGlucoseLevel", "Blood Glucose Level"],
    series: [
      {
        key: "bloodGlucoseLevel",
        label: "Blood Glucose",
        color: "#D33030",
        unit: "mg/dL",
      },
    ],
  },
  peakExpiratoryFlowRate: {
    title: "Peak Expiratory Flow Rate",
    unit: "L/min",
    categoryKeys: ["peakExpiratoryFlowRate", "Peak Expiratory Flow Rate"],
    series: [
      {
        key: "peakExpiratoryFlowRate",
        label: "Peak Flow",
        color: "#4E807F",
        unit: "L/min",
      },
    ],
  },
};

// Keep request validation in this file so the callable only handles auth and
// error wrapping. The RN screen limits ranges to 12 weeks, and the function
// enforces the same limit before querying data.
const validateRequest = (data: any): VitalInsightsRequest => {
  const {childId, vitalKey, startAt, endAt, preset} = data ?? {};

  if (typeof childId !== "string" || !childId.trim()) {
    throw new v1.https.HttpsError("invalid-argument", "childId is required.");
  }

  if (!Object.prototype.hasOwnProperty.call(VITAL_CONFIG, vitalKey)) {
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
    childId: childId.trim(),
    vitalKey,
    startAt,
    endAt,
    preset,
  };
};

// Vitals are entered through text inputs in the RN app, so Firebase usually
// stores the measurements as strings. Only finite numeric values are chartable.
const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const isInRequestedRange = (
  timestamp: number | null,
  request: VitalInsightsRequest
): timestamp is number =>
  timestamp !== null &&
  timestamp >= request.startAt &&
  timestamp <= request.endAt;

const fetchVitalRecords = async (
  db: admin.database.Database,
  request: VitalInsightsRequest,
  categoryKeys: string[]
): Promise<TrackingRecord[]> => {
  const recordsById = new Map<string, TrackingRecord>();

  // RTDB can query one category value at a time. Query each known category key
  // for this vital, then de-dupe by Firebase key before sorting by reading time.
  await Promise.all(
    categoryKeys.map(async (category) => {
      const snapshot = await db
        .ref(`/tracking/${request.childId}`)
        .orderByChild("category")
        .equalTo(category)
        .once("value");

      snapshot.forEach((childSnapshot) => {
        const record = childSnapshot.val() as TrackingRecord | null;

        if (record?.trackingType === "vitals") {
          recordsById.set(childSnapshot.key ?? record.id ?? category, {
            ...record,
            id: record.id ?? childSnapshot.key ?? undefined,
          });
        }

        return false;
      });
    })
  );

  return [...recordsById.values()].sort((a, b) => {
    const aTime = toNumber(a.data?.dateTime) ?? 0;
    const bTime = toNumber(b.data?.dateTime) ?? 0;
    return aTime - bTime;
  });
};

// Even when there are no readings, the frontend expects the same series objects
// so it can render legends, stats, and the no-data state without null checks.
const buildEmptySeries = (config: VitalConfig): VitalInsightsSeries[] =>
  config.series.map((series) => ({
    ...series,
    points: [],
  }));

const getStatsForSingleSeries = (
  unit: string,
  points: VitalInsightsPoint[]
): VitalInsightsStat[] => {
  if (points.length === 0) {
    // Preserve the stat keys the RN UI translates, but avoid fake numeric data.
    return [
      {key: "latest", value: "No data"},
      {key: "highest", value: "No data"},
      {key: "lowest", value: "No data"},
      {key: "totalReadings", value: "0"},
    ];
  }

  const sortedByValue = [...points].sort((a, b) => a.value - b.value);
  const latest = points[points.length - 1];
  const lowest = sortedByValue[0];
  const highest = sortedByValue[sortedByValue.length - 1];

  return [
    {key: "latest", value: `${latest.value} ${unit}`},
    {key: "highest", value: `${highest.value} ${unit}`},
    {key: "lowest", value: `${lowest.value} ${unit}`},
    {key: "totalReadings", value: String(points.length)},
  ];
};

const getStatsForBloodPressure = (
  systolic: VitalInsightsPoint[],
  diastolic: VitalInsightsPoint[]
): VitalInsightsStat[] => {
  if (systolic.length === 0 || diastolic.length === 0) {
    // Blood pressure has different stat keys because the chart has two series.
    return [
      {key: "latestBp", value: "No data"},
      {key: "highestSys", value: "No data"},
      {key: "lowestDia", value: "No data"},
      {key: "totalReadings", value: "0"},
    ];
  }

  const highestSys = [...systolic].sort((a, b) => b.value - a.value)[0];
  const lowestDia = [...diastolic].sort((a, b) => a.value - b.value)[0];
  const latestSys = systolic[systolic.length - 1];
  const latestDia = diastolic[diastolic.length - 1];

  return [
    {
      key: "latestBp",
      value: `${latestSys.value}/${latestDia.value} mmHg`,
    },
    {key: "highestSys", value: `${highestSys.value} mmHg`},
    {key: "lowestDia", value: `${lowestDia.value} mmHg`},
    {key: "totalReadings", value: String(systolic.length)},
  ];
};

const buildSeriesFromRecords = (
  request: VitalInsightsRequest,
  records: TrackingRecord[],
  config: VitalConfig
): VitalInsightsSeries[] => {
  const series = buildEmptySeries(config);

  // Convert each tracking record into one or more chart points. Single-value
  // vitals use data.value; blood pressure uses paired SYS/DIA values.
  records.forEach((record) => {
    const timestamp = toNumber(record.data?.dateTime);

    if (!isInRequestedRange(timestamp, request)) {
      return;
    }

    if (request.vitalKey === "bloodPressure") {
      const systolic = toNumber(record.data?.sysValue);
      const diastolic = toNumber(record.data?.diaValue);

      if (systolic !== null && diastolic !== null) {
        series[0].points.push({timestamp, value: systolic});
        series[1].points.push({timestamp, value: diastolic});
      }

      return;
    }

    const value = toNumber(record.data?.value);

    if (value !== null) {
      series[0].points.push({timestamp, value});
    }
  });

  return series;
};

export const getVitalInsightsPayload = async (
  rawData: any,
  db: admin.database.Database
): Promise<VitalInsightsResponse> => {
  // Main flow: validate request, load matching tracking rows, map them into the
  // chart contract the RN VitalInsights screen already consumes, then summarize.
  const request = validateRequest(rawData);
  const config = VITAL_CONFIG[request.vitalKey];
  const records = await fetchVitalRecords(db, request, config.categoryKeys);
  const series = buildSeriesFromRecords(request, records, config);
  const stats =
    request.vitalKey === "bloodPressure"
      ? getStatsForBloodPressure(series[0].points, series[1].points)
      : getStatsForSingleSeries(config.unit, series[0].points);

  return {
    vitalKey: request.vitalKey,
    title: config.title,
    unit: config.unit,
    range: {
      startAt: request.startAt,
      endAt: request.endAt,
      preset: request.preset,
    },
    series,
    stats,
  };
};
