import * as admin from "firebase-admin";
import * as v1 from "firebase-functions/v1";

export type GrowthInsightsGrowthKey = "height" | "weight";
export type GrowthInsightsUnitSystem = "imperial" | "metric";
export type GrowthInsightsPreset =
  | "1W"
  | "4W"
  | "12W"
  | "6M"
  | "12M"
  | "CUSTOM";

export type GrowthInsightsRequest = {
  childId: string;
  growthKey: GrowthInsightsGrowthKey;
  unitSystem: GrowthInsightsUnitSystem;
  startAt: number;
  endAt: number;
  preset: GrowthInsightsPreset;
  folderName?: string;
};

type GrowthInsightsPoint = {
  timestamp: number;
  value: number;
};

type GrowthInsightsSeries = {
  key: GrowthInsightsGrowthKey;
  label: string;
  color: string;
  unit: string;
  points: GrowthInsightsPoint[];
};

type GrowthInsightsStat = {
  key: "latest" | "highest" | "lowest" | "totalReadings";
  value: string;
};

type InsightsReportComment = {
  timestamp: number;
  notes?: string;
  conditionReason?: string;
};

export type GrowthInsightsResponse = {
  growthKey: GrowthInsightsGrowthKey;
  unitSystem: GrowthInsightsUnitSystem;
  title: string;
  unit: string;
  range: {
    startAt: number;
    endAt: number;
    preset: GrowthInsightsPreset;
  };
  series: GrowthInsightsSeries[];
  stats: GrowthInsightsStat[];
  comments?: InsightsReportComment[];
};

type TrackingRecord = {
  id?: string;
  childId?: string;
  trackingType?: string;
  category?: string;
  folder?: {
    name?: string;
  };
  data?: {
    unit?: string;
    unitMajor?: string | number;
    unitMinor?: string | number;
    dateTime?: string | number;
    notes?: string;
    conditionReason?: string;
  };
};

type GrowthConfig = {
  title: string;
  categoryKeys: string[];
  color: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = DAY_MS * 366;
const KG_TO_LBS = 2.2046226218;
const CM_TO_IN = 1 / 2.54;

const GROWTH_CONFIG: Record<GrowthInsightsGrowthKey, GrowthConfig> = {
  height: {
    title: "Height",
    categoryKeys: ["height", "Height"],
    color: "#2E9593",
  },
  weight: {
    title: "Weight",
    categoryKeys: ["weight", "Weight"],
    color: "#D33030",
  },
};

const getGrowthUnit = (
  growthKey: GrowthInsightsGrowthKey,
  unitSystem: GrowthInsightsUnitSystem
): string => {
  if (growthKey === "height") {
    return unitSystem === "imperial" ? "in" : "cm";
  }

  return unitSystem === "imperial" ? "lbs" : "kg";
};

const validateRequest = (data: any): GrowthInsightsRequest => {
  const {childId, growthKey, unitSystem, startAt, endAt, preset, folderName} =
    data ?? {};

  if (typeof childId !== "string" || !childId.trim()) {
    throw new v1.https.HttpsError("invalid-argument", "childId is required.");
  }

  if (!Object.prototype.hasOwnProperty.call(GROWTH_CONFIG, growthKey)) {
    throw new v1.https.HttpsError("invalid-argument", "Unsupported growth key.");
  }

  if (unitSystem !== "imperial" && unitSystem !== "metric") {
    throw new v1.https.HttpsError("invalid-argument", "Unsupported unit system.");
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
      "The selected range cannot exceed 12 months."
    );
  }

  if (
    preset !== "1W" &&
    preset !== "4W" &&
    preset !== "12W" &&
    preset !== "6M" &&
    preset !== "12M" &&
    preset !== "CUSTOM"
  ) {
    throw new v1.https.HttpsError("invalid-argument", "Unsupported preset.");
  }

  return {
    childId: childId.trim(),
    growthKey,
    unitSystem,
    startAt,
    endAt,
    preset,
    folderName:
      typeof folderName === "string" && folderName.trim()
        ? folderName.trim()
        : undefined,
  };
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const roundGrowthValue = (value: number): number =>
  Math.round(value * 10) / 10;

const normalizeGrowthValue = (
  record: TrackingRecord,
  request: GrowthInsightsRequest
): number | null => {
  const unit =
    typeof record.data?.unit === "string"
      ? record.data.unit.trim().toLowerCase()
      : "";
  const major = toNumber(record.data?.unitMajor);
  const minor = toNumber(record.data?.unitMinor);

  if (major === null && minor === null) {
    return null;
  }

  const safeMajor = major ?? 0;
  const safeMinor = minor ?? 0;

  if (request.growthKey === "weight") {
    if (unit === "lbs" || unit === "lb") {
      const pounds = safeMajor + safeMinor / 16;
      return roundGrowthValue(
        request.unitSystem === "imperial" ? pounds : pounds / KG_TO_LBS
      );
    }

    if (unit === "oz" || unit === "ounce") {
      const pounds = (safeMajor + safeMinor) / 16;
      return roundGrowthValue(
        request.unitSystem === "imperial" ? pounds : pounds / KG_TO_LBS
      );
    }

    if (unit === "kg" || unit === "kgs") {
      const kilograms = safeMajor + safeMinor / 1000;
      return roundGrowthValue(
        request.unitSystem === "metric" ? kilograms : kilograms * KG_TO_LBS
      );
    }

    if (unit === "g" || unit === "gram") {
      const kilograms = (safeMajor + safeMinor) / 1000;
      return roundGrowthValue(
        request.unitSystem === "metric" ? kilograms : kilograms * KG_TO_LBS
      );
    }

    return null;
  }

  if (unit === "ft" || unit === "feet") {
    const inches = safeMajor * 12 + safeMinor;
    return roundGrowthValue(
      request.unitSystem === "imperial" ? inches : inches / CM_TO_IN
    );
  }

  if (unit === "in" || unit === "inch") {
    const inches = safeMajor + safeMinor;
    return roundGrowthValue(
      request.unitSystem === "imperial" ? inches : inches / CM_TO_IN
    );
  }

  if (unit === "m" || unit === "meter") {
    const centimeters = safeMajor * 100 + safeMinor;
    return roundGrowthValue(
      request.unitSystem === "metric" ? centimeters : centimeters * CM_TO_IN
    );
  }

  if (unit === "cm" || unit === "centimeter") {
    const centimeters = safeMajor + safeMinor;
    return roundGrowthValue(
      request.unitSystem === "metric" ? centimeters : centimeters * CM_TO_IN
    );
  }

  return null;
};

const isInRequestedRange = (
  timestamp: number | null,
  request: GrowthInsightsRequest
): timestamp is number =>
  timestamp !== null &&
  timestamp >= request.startAt &&
  timestamp <= request.endAt;

const fetchGrowthRecords = async (
  db: admin.database.Database,
  request: GrowthInsightsRequest,
  categoryKeys: string[]
): Promise<TrackingRecord[]> => {
  const recordsById = new Map<string, TrackingRecord>();

  await Promise.all(
    categoryKeys.map(async (category) => {
      const snapshot = await db
        .ref(`/tracking/${request.childId}`)
        .orderByChild("category")
        .equalTo(category)
        .once("value");

      snapshot.forEach((childSnapshot) => {
        const record = childSnapshot.val() as TrackingRecord | null;

        if (
          record?.trackingType === "growth" &&
          (!request.folderName || record.folder?.name === request.folderName)
        ) {
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

const buildEmptySeries = (
  request: GrowthInsightsRequest,
  config: GrowthConfig
): GrowthInsightsSeries[] => [
  {
    key: request.growthKey,
    label: config.title,
    color: config.color,
    unit: getGrowthUnit(request.growthKey, request.unitSystem),
    points: [],
  },
];

const getStatsForSeries = (
  unit: string,
  points: GrowthInsightsPoint[]
): GrowthInsightsStat[] => {
  if (points.length === 0) {
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

const buildSeriesFromRecords = (
  request: GrowthInsightsRequest,
  records: TrackingRecord[],
  config: GrowthConfig
): GrowthInsightsSeries[] => {
  const series = buildEmptySeries(request, config);

  records.forEach((record) => {
    const timestamp = toNumber(record.data?.dateTime);

    if (!isInRequestedRange(timestamp, request)) {
      return;
    }

    const value = normalizeGrowthValue(record, request);

    if (value !== null) {
      series[0].points.push({timestamp, value});
    }
  });

  return series;
};

const getComments = (records: TrackingRecord[]): InsightsReportComment[] =>
  records
    .map((record) => ({
      timestamp: toNumber(record.data?.dateTime) ?? 0,
      notes: record.data?.notes,
      conditionReason: record.data?.conditionReason,
    }))
    .filter(
      (comment) =>
        typeof comment.notes === "string" ||
        typeof comment.conditionReason === "string"
    );

export const getGrowthInsightsPayload = async (
  rawData: any,
  db: admin.database.Database
): Promise<GrowthInsightsResponse> => {
  const request = validateRequest(rawData);
  const config = GROWTH_CONFIG[request.growthKey];
  const records = await fetchGrowthRecords(db, request, config.categoryKeys);
  const series = buildSeriesFromRecords(request, records, config);
  const unit = getGrowthUnit(request.growthKey, request.unitSystem);

  return {
    growthKey: request.growthKey,
    unitSystem: request.unitSystem,
    title: config.title,
    unit,
    range: {
      startAt: request.startAt,
      endAt: request.endAt,
      preset: request.preset,
    },
    series,
    stats: getStatsForSeries(unit, series[0].points),
    comments: getComments(records),
  };
};
