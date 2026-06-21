import * as admin from "firebase-admin";
import * as v1 from "firebase-functions/v1";

export type SymptomInsightsTrackingType = "symptoms" | "sideEffects";
export type SymptomInsightsPreset = "1W" | "4W" | "12W" | "CUSTOM";
export type TemperatureUnit = "F" | "C";
export type SymptomSeverity = "mild" | "moderate" | "severe";
export type SymptomPainLevel =
  | "noPain"
  | "hurtsALittle"
  | "hurtsALittleMore"
  | "hurtsAWholeLot"
  | "hurtsWorst";

export type SymptomInsightsRequest = {
  childId: string;
  trackingType: SymptomInsightsTrackingType;
  symptomKey: string;
  startAt: number;
  endAt: number;
  preset: SymptomInsightsPreset;
  displayUnit?: TemperatureUnit;
};

type SymptomInsightsPoint = {
  timestamp: number;
  value: number;
};

type TemperatureInsightsPoint = SymptomInsightsPoint & {
  unit: TemperatureUnit;
  originalValue: number;
  originalUnit: TemperatureUnit;
};

type OrdinalSymptomInsightsPoint = SymptomInsightsPoint & {
  label: string;
};

type SymptomInsightsSeries<TPoint extends SymptomInsightsPoint> = {
  key: string;
  label: string;
  color: string;
  points: TPoint[];
};

type SymptomInsightsStat = {
  key:
    | "latest"
    | "highest"
    | "lowest"
    | "totalReadings"
    | "latestSeverity"
    | "highestSeverity"
    | "latestPain"
    | "highestPain";
  value: string;
};

type SymptomInsightsFieldCoverage = {
  totalEntries: number;
  recordedEntries: number;
  missingEntries: number;
};

type TemperatureInsightsResponse = {
  kind: "temperature";
  trackingType: SymptomInsightsTrackingType;
  symptomKey: string;
  title: string;
  unit: TemperatureUnit;
  range: {
    startAt: number;
    endAt: number;
    preset: SymptomInsightsPreset;
  };
  temperatureSeries: SymptomInsightsSeries<TemperatureInsightsPoint>;
  painSeries?: SymptomInsightsSeries<OrdinalSymptomInsightsPoint>;
  coverage: {
    temperature: SymptomInsightsFieldCoverage;
    pain?: SymptomInsightsFieldCoverage;
  };
  stats: SymptomInsightsStat[];
};

type OrdinalSymptomInsightsResponse = {
  kind: "ordinalSymptom";
  trackingType: SymptomInsightsTrackingType;
  symptomKey: string;
  title: string;
  range: {
    startAt: number;
    endAt: number;
    preset: SymptomInsightsPreset;
  };
  severitySeries: SymptomInsightsSeries<OrdinalSymptomInsightsPoint>;
  painSeries: SymptomInsightsSeries<OrdinalSymptomInsightsPoint>;
  coverage: {
    severity: SymptomInsightsFieldCoverage;
    pain: SymptomInsightsFieldCoverage;
  };
  stats: SymptomInsightsStat[];
};

export type SymptomInsightsResponse =
  | TemperatureInsightsResponse
  | OrdinalSymptomInsightsResponse;

type TrackingRecord = {
  id?: string;
  trackingType?: string;
  data?: {
    dateTime?: string | number;
    symptoms?: Record<string, any>;
  };
};

type MatchingSymptomEntry = {
  timestamp: number;
  item: any;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = DAY_MS * 84;
const DEFAULT_TEMPERATURE_UNIT: TemperatureUnit = "F";

const SYMPTOM_INSIGHTS_COLORS = {
  temperature: "#D33030",
  severity: "#3448F0",
  pain: "#3BA8A7",
};

const SEVERITY_SCORE_BY_VALUE: Record<SymptomSeverity, number> = {
  mild: 1,
  moderate: 2,
  severe: 3,
};

const PAIN_SCORE_BY_VALUE: Record<SymptomPainLevel, number> = {
  noPain: 0,
  hurtsALittle: 1,
  hurtsALittleMore: 2,
  hurtsAWholeLot: 3,
  hurtsWorst: 4,
};

const SEVERITY_LABEL_BY_VALUE: Record<SymptomSeverity, string> = {
  mild: "Mild",
  moderate: "Moderate",
  severe: "Severe",
};

const PAIN_LABEL_BY_VALUE: Record<SymptomPainLevel, string> = {
  noPain: "No pain",
  hurtsALittle: "Hurts a little",
  hurtsALittleMore: "Hurts a little more",
  hurtsAWholeLot: "Hurts a whole lot",
  hurtsWorst: "Hurts worst",
};

const SYMPTOM_LABEL_BY_ID: Record<string, string> = {
  temperature: "Temperature",
  tremors: "Tremors",
  cough: "Cough",
  congestionRunningNose: "Congestion / runny nose",
  wheezing: "Wheezing",
  soreThroat: "Sore throat",
  headache: "Headache",
  pain: "Pain",
  blurredVision: "Blurred vision",
  frequentUrination: "Frequent urination",
  decreasedUrination: "Decreased urination",
  dryEyes: "Dry eyes",
  constipation: "Constipation",
  diarrhea: "Diarrhea",
  vomiting: "Vomiting",
  nausea: "Nausea",
  abdominalPain: "Abdominal pain",
  upsetStomach: "Upset stomach",
  rash: "Rash",
  itching: "Itching",
  concentrationProblems: "Concentration problems",
  inattention: "Inattention",
  hyperactivity: "Hyperactivity",
  tics: "Tics",
  redness: "Redness",
  swelling: "Swelling",
  fatigueEnergyLoss: "Fatigue / energy loss",
  shortageOfBreath: "Shortness of breath",
  muscleWeakness: "Muscle weakness",
  muscleCramps: "Muscle cramps",
  jointPain: "Joint pain",
  drowsiness: "Drowsiness",
  dizziness: "Dizziness",
  lightheadedness: "Lightheadedness",
  palpitations: "Palpitations",
  rapidHeartbeat: "Rapid heartbeat",
  dryMouth: "Dry mouth",
  changeInTaste: "Change in taste",
  hairLoss: "Hair loss",
  increasedSweating: "Increased sweating",
  weightLoss: "Weight loss",
  weightGain: "Weight gain",
  lowBloodPressure: "Low blood pressure",
  easyBruising: "Easy bruising",
  lossOfAppetite: "Loss of appetite",
  sleepDisturbance: "Sleep disturbance",
  confusion: "Confusion",
  irritability: "Irritability",
  restlessness: "Restlessness",
  moodSwings: "Mood swings",
  sadness: "Sadness",
  lossOfInterest: "Loss of interest",
  excessiveWorry: "Excessive worry",
  avoidanceBehavior: "Avoidance behavior",
  other: "Other",
};

const validateRequest = (data: any): SymptomInsightsRequest => {
  const {
    childId,
    trackingType,
    symptomKey,
    startAt,
    endAt,
    preset,
    displayUnit,
  } = data ?? {};

  if (typeof childId !== "string" || !childId.trim()) {
    throw new v1.https.HttpsError("invalid-argument", "childId is required.");
  }

  if (trackingType !== "symptoms" && trackingType !== "sideEffects") {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "trackingType must be symptoms or sideEffects."
    );
  }

  if (typeof symptomKey !== "string" || !symptomKey.trim()) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "symptomKey is required."
    );
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

  if (
    displayUnit !== undefined &&
    displayUnit !== "F" &&
    displayUnit !== "C"
  ) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "displayUnit must be F or C."
    );
  }

  return {
    childId: childId.trim(),
    trackingType,
    symptomKey: symptomKey.trim(),
    startAt,
    endAt,
    preset,
    displayUnit,
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

const normalizeTemperatureUnit = (
  value: unknown
): TemperatureUnit | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLowerCase().replace("°", "").trim();

  if (normalized === "f") {
    return "F";
  }

  if (normalized === "c") {
    return "C";
  }

  return undefined;
};

const convertTemperature = (
  value: number,
  fromUnit: TemperatureUnit,
  toUnit: TemperatureUnit
): number => {
  if (fromUnit === toUnit) {
    return value;
  }

  if (fromUnit === "C") {
    return value * 1.8 + 32;
  }

  return (value - 32) / 1.8;
};

const getSymptomTitle = (symptomKey: string, entries: MatchingSymptomEntry[]) => {
  const customName = entries.find(({item}) => typeof item.symptomName === "string")
    ?.item.symptomName;

  if (customName?.trim()) {
    return customName.trim();
  }

  return SYMPTOM_LABEL_BY_ID[symptomKey] ?? symptomKey;
};

const fetchTrackingRecords = async (
  db: admin.database.Database,
  request: SymptomInsightsRequest
): Promise<TrackingRecord[]> => {
  const snapshot = await db
    .ref(`/tracking/${request.childId}`)
    .orderByChild("trackingType")
    .equalTo(request.trackingType)
    .once("value");
  const records: TrackingRecord[] = [];

  snapshot.forEach((childSnapshot) => {
    const record = childSnapshot.val() as TrackingRecord | null;

    if (record?.trackingType === request.trackingType) {
      records.push({
        ...record,
        id: record.id ?? childSnapshot.key ?? undefined,
      });
    }

    return false;
  });

  return records;
};

const getMatchingEntries = (
  records: TrackingRecord[],
  request: SymptomInsightsRequest
): MatchingSymptomEntry[] =>
  records
    .flatMap((record) => {
      const item = record.data?.symptoms?.[request.symptomKey];

      if (!item) {
        return [];
      }

      const timestamp = toNumber(item.dateTime ?? record.data?.dateTime);

      if (
        timestamp === null ||
        timestamp < request.startAt ||
        timestamp > request.endAt
      ) {
        return [];
      }

      return [{timestamp, item}];
    })
    .sort((a, b) => a.timestamp - b.timestamp);

const formatTemperatureValue = (value: number, unit: TemperatureUnit): string =>
  `${value.toFixed(1)}°${unit}`;

const getTemperatureStats = (
  points: TemperatureInsightsPoint[],
  unit: TemperatureUnit
): SymptomInsightsStat[] => {
  if (points.length === 0) {
    return [];
  }

  const sortedByValue = [...points].sort((a, b) => a.value - b.value);
  const latest = points[points.length - 1];
  const lowest = sortedByValue[0];
  const highest = sortedByValue[sortedByValue.length - 1];

  return [
    {key: "latest", value: formatTemperatureValue(latest.value, unit)},
    {key: "highest", value: formatTemperatureValue(highest.value, unit)},
    {key: "lowest", value: formatTemperatureValue(lowest.value, unit)},
    {key: "totalReadings", value: String(points.length)},
  ];
};

const getOrdinalStats = (
  severityPoints: OrdinalSymptomInsightsPoint[],
  painPoints: OrdinalSymptomInsightsPoint[]
): SymptomInsightsStat[] => {
  const stats: SymptomInsightsStat[] = [];

  if (severityPoints.length > 0) {
    const highestSeverity = [...severityPoints].sort(
      (a, b) => b.value - a.value
    )[0];
    const latestSeverity = severityPoints[severityPoints.length - 1];

    stats.push(
      {key: "latestSeverity", value: latestSeverity.label},
      {key: "highestSeverity", value: highestSeverity.label}
    );
  }

  if (painPoints.length > 0) {
    const highestPain = [...painPoints].sort((a, b) => b.value - a.value)[0];
    const latestPain = painPoints[painPoints.length - 1];

    stats.push(
      {key: "latestPain", value: latestPain.label},
      {key: "highestPain", value: highestPain.label}
    );
  }

  stats.push({
    key: "totalReadings",
    value: String(Math.max(severityPoints.length, painPoints.length)),
  });

  return stats;
};

const buildPainPoints = (
  entries: MatchingSymptomEntry[]
): OrdinalSymptomInsightsPoint[] =>
  entries.flatMap(({timestamp, item}) => {
    const pain = item.levelOfPain as SymptomPainLevel | undefined;

    if (!pain || PAIN_SCORE_BY_VALUE[pain] === undefined) {
      return [];
    }

    return [
      {
        timestamp,
        value: PAIN_SCORE_BY_VALUE[pain],
        label: PAIN_LABEL_BY_VALUE[pain],
      },
    ];
  });

const getFieldCoverage = (
  totalEntries: number,
  recordedEntries: number
): SymptomInsightsFieldCoverage => ({
  totalEntries,
  recordedEntries,
  missingEntries: Math.max(0, totalEntries - recordedEntries),
});

const buildTemperatureResponse = (
  request: SymptomInsightsRequest,
  matchingEntries: MatchingSymptomEntry[],
  title: string
): TemperatureInsightsResponse => {
  const displayUnit = request.displayUnit ?? DEFAULT_TEMPERATURE_UNIT;
  const points: TemperatureInsightsPoint[] = matchingEntries.flatMap(
    ({timestamp, item}) => {
      const originalValue = toNumber(item.value);
      const originalUnit = normalizeTemperatureUnit(item.degree) ?? displayUnit;

      if (originalValue === null) {
        return [];
      }

      const value = convertTemperature(originalValue, originalUnit, displayUnit);

      return [
        {
          timestamp,
          value: Number(value.toFixed(1)),
          unit: displayUnit,
          originalValue,
          originalUnit,
        },
      ];
    }
  );
  const painPoints = buildPainPoints(matchingEntries);
  const totalEntries = matchingEntries.length;
  const stats = [
    ...getTemperatureStats(points, displayUnit),
    ...getOrdinalStats([], painPoints).filter(
      (stat) => stat.key !== "totalReadings"
    ),
  ];

  return {
    kind: "temperature",
    trackingType: request.trackingType,
    symptomKey: request.symptomKey,
    title,
    unit: displayUnit,
    range: {
      startAt: request.startAt,
      endAt: request.endAt,
      preset: request.preset,
    },
    temperatureSeries: {
      key: "temperature",
      label: title,
      color: SYMPTOM_INSIGHTS_COLORS.temperature,
      points,
    },
    painSeries: {
      key: "pain",
      label: "Pain/discomfort trend",
      color: SYMPTOM_INSIGHTS_COLORS.pain,
      points: painPoints,
    },
    coverage: {
      temperature: getFieldCoverage(totalEntries, points.length),
      pain: getFieldCoverage(totalEntries, painPoints.length),
    },
    stats,
  };
};

const buildOrdinalResponse = (
  request: SymptomInsightsRequest,
  matchingEntries: MatchingSymptomEntry[],
  title: string
): OrdinalSymptomInsightsResponse => {
  const severityPoints: OrdinalSymptomInsightsPoint[] = matchingEntries.flatMap(
    ({timestamp, item}) => {
      const severity = item.severity as SymptomSeverity | undefined;

      if (!severity || SEVERITY_SCORE_BY_VALUE[severity] === undefined) {
        return [];
      }

      return [
        {
          timestamp,
          value: SEVERITY_SCORE_BY_VALUE[severity],
          label: SEVERITY_LABEL_BY_VALUE[severity],
        },
      ];
    }
  );
  const painPoints = buildPainPoints(matchingEntries);
  const totalEntries = matchingEntries.length;

  return {
    kind: "ordinalSymptom",
    trackingType: request.trackingType,
    symptomKey: request.symptomKey,
    title,
    range: {
      startAt: request.startAt,
      endAt: request.endAt,
      preset: request.preset,
    },
    severitySeries: {
      key: "severity",
      label: "Severity trend",
      color: SYMPTOM_INSIGHTS_COLORS.severity,
      points: severityPoints,
    },
    painSeries: {
      key: "pain",
      label: "Pain/discomfort trend",
      color: SYMPTOM_INSIGHTS_COLORS.pain,
      points: painPoints,
    },
    coverage: {
      severity: getFieldCoverage(totalEntries, severityPoints.length),
      pain: getFieldCoverage(totalEntries, painPoints.length),
    },
    stats: getOrdinalStats(severityPoints, painPoints),
  };
};

export const getSymptomInsightsPayload = async (
  rawData: any,
  db: admin.database.Database
): Promise<SymptomInsightsResponse> => {
  const request = validateRequest(rawData);
  const records = await fetchTrackingRecords(db, request);
  const matchingEntries = getMatchingEntries(records, request);
  const title = getSymptomTitle(request.symptomKey, matchingEntries);

  if (request.symptomKey === "temperature") {
    return buildTemperatureResponse(request, matchingEntries, title);
  }

  return buildOrdinalResponse(request, matchingEntries, title);
};
