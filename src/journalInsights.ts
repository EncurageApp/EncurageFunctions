import * as admin from "firebase-admin";
import * as v1 from "firebase-functions/v1";

export type JournalInsightsPreset = "1W" | "4W" | "12W" | "CUSTOM";

export type JournalInsightsSubjectKey =
  | "pain"
  | "energy"
  | "fatigue"
  | "appetite"
  | "sleep"
  | "attentionConcentration"
  | "symptomControl"
  | "socialWellbeing"
  | "qualityOfLife";

export type JournalInsightsRequest = {
  childId: string;
  subjectKey: JournalInsightsSubjectKey;
  symptomId?: string;
  startAt: number;
  endAt: number;
  preset: JournalInsightsPreset;
  folderName?: string;
};

type JournalInsightsPoint = {
  timestamp: number;
  value: number;
  label: string;
};

type JournalInsightsSeries = {
  key: string;
  label: string;
  color: string;
  valueLabels: string[];
  points: JournalInsightsPoint[];
};

type JournalInsightsStat = {
  key: string;
  label: string;
  value: string;
};

type JournalInsightsReadingRow = {
  timestamp: number;
  values: Record<string, string>;
  keyEvents: string[];
};

export type JournalInsightsResponse = {
  subjectKey: JournalInsightsSubjectKey;
  symptomId?: string;
  title: string;
  range: {
    startAt: number;
    endAt: number;
    preset: JournalInsightsPreset;
  };
  series: JournalInsightsSeries[];
  stats: JournalInsightsStat[];
  readings: JournalInsightsReadingRow[];
  comments?: Array<{timestamp: number; notes?: string}>;
};

type JournalRecord = {
  id?: string;
  folder?: {
    name?: string;
  };
  data?: {
    dateTime?: string | number;
    subjects?: Record<string, Record<string, any>>;
  };
};

type JournalSeriesConfig = {
  key: string;
  label: string;
  valueKey: string;
  valueKeys: string[];
  valueLabels: string[];
  color: string;
  eventPrefixes?: string[];
  notesKeys?: string[];
};

type JournalSubjectConfig = {
  title: string;
  series: JournalSeriesConfig[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = DAY_MS * 84;

const JOURNAL_CONFIG: Record<JournalInsightsSubjectKey, JournalSubjectConfig> = {
  pain: {
    title: "Pain",
    series: [
      {
        key: "pain",
        label: "Pain",
        valueKey: "pain",
        valueKeys: [
          "noPain",
          "hurtsALittle",
          "hurtsALittleMore",
          "hurtsWholeLot",
          "hurtsWorst",
        ],
        valueLabels: [
          "No Pain",
          "Hurts a little",
          "Hurts a little more",
          "Hurts a whole lot",
          "Hurts worst",
        ],
        color: "#D33030",
      },
    ],
  },
  energy: {
    title: "Energy",
    series: [
      {
        key: "energy",
        label: "Energy",
        valueKey: "energy",
        valueKeys: [
          "veryLow",
          "slightlyLow",
          "regularLevel",
          "high",
          "veryHigh",
        ],
        valueLabels: [
          "Very low",
          "Slightly low",
          "Regular level",
          "High",
          "Very high",
        ],
        color: "#2E9593",
      },
    ],
  },
  fatigue: {
    title: "Fatigue",
    series: [
      {
        key: "fatigue",
        label: "Fatigue",
        valueKey: "fatigue",
        valueKeys: [
          "noFatigue",
          "littleFatigued",
          "somewhatFatigued",
          "veryFatigued",
          "extremelyFatigued",
        ],
        valueLabels: [
          "No fatigue",
          "A little fatigued",
          "Somewhat fatigued",
          "Very fatigued",
          "Extremely fatigued",
        ],
        color: "#CA8A09",
      },
    ],
  },
  appetite: {
    title: "Appetite",
    series: [
      {
        key: "appetite",
        label: "Appetite",
        valueKey: "appetite",
        valueKeys: [
          "extremelyDecreased",
          "somewhatDecreased",
          "regular",
          "somewhatIncreased",
          "extremelyIncreased",
        ],
        valueLabels: [
          "Extremely decreased",
          "Somewhat decreased",
          "Regular",
          "Somewhat increased",
          "Extremely increased",
        ],
        color: "#3BA8A7",
      },
    ],
  },
  sleep: {
    title: "Sleep",
    series: [
      {
        key: "sleepLength",
        label: "Sleep Length",
        valueKey: "sleepLength",
        valueKeys: [
          "extremelyShort",
          "somewhatShort",
          "average",
          "somewhatLong",
          "extremelyLong",
        ],
        valueLabels: [
          "Extremely Short",
          "Somewhat Short",
          "Regular Length",
          "Somewhat Long",
          "Extremely Long",
        ],
        color: "#3448F0",
        eventPrefixes: ["length"],
        notesKeys: ["lengthNotes"],
      },
      {
        key: "sleepQuality",
        label: "Sleep Quality",
        valueKey: "sleepQuality",
        valueKeys: ["veryPoor", "poor", "average", "good", "excellent"],
        valueLabels: ["Very Poor", "Poor", "Average", "Good", "Excellent"],
        color: "#3BA8A7",
        eventPrefixes: ["quality"],
        notesKeys: ["qualityNotes"],
      },
    ],
  },
  attentionConcentration: {
    title: "Attention & Concentration",
    series: [
      {
        key: "attentionConcentration",
        label: "Attention & Concentration",
        valueKey: "attentionConcentration",
        valueKeys: [
          "attentive",
          "mostlyAttentive",
          "partlyAttentive",
          "mostlyInattentive",
          "inattentive",
        ],
        valueLabels: [
          "Attentive",
          "Mostly attentive",
          "Partly attentive",
          "Mostly inattentive",
          "Inattentive",
        ],
        color: "#4E807F",
      },
    ],
  },
  symptomControl: {
    title: "Symptom Control",
    series: [
      {
        key: "symptomControl",
        label: "Symptom Control",
        valueKey: "symptomControl",
        valueKeys: ["none", "veryLow", "low", "medium", "high", "veryHigh"],
        valueLabels: ["None!", "Very Low", "Low", "Medium", "High", "Very High"],
        color: "#D33030",
      },
    ],
  },
  socialWellbeing: {
    title: "Social Wellbeing",
    series: [
      {
        key: "socialWellBeing",
        label: "Frequency of involvement",
        valueKey: "socialWellBeing",
        valueKeys: ["veryLow", "low", "regular", "high", "veryHigh"],
        valueLabels: ["Very low", "Low", "Regular", "High", "Very high"],
        color: "#2E9593",
        eventPrefixes: ["frequency"],
        notesKeys: ["frequencyNotes"],
      },
      {
        key: "socialConnection",
        label: "Enjoyment of connections",
        valueKey: "socialConnection",
        valueKeys: [
          "almostNever",
          "smallTime",
          "someTime",
          "often",
          "mostTime",
        ],
        valueLabels: [
          "Almost never",
          "A small part of the time",
          "Some of the time",
          "Often",
          "Most or All of the time",
        ],
        color: "#CA8A09",
        eventPrefixes: ["enjoyment"],
        notesKeys: ["enjoymentNotes"],
      },
    ],
  },
  qualityOfLife: {
    title: "Quality of Life",
    series: [
      {
        key: "qualityOfLife",
        label: "Quality of Life",
        valueKey: "qualityOfLife",
        valueKeys: ["veryPoor", "poor", "fair", "good", "amazing"],
        valueLabels: ["Very Poor", "Poor", "Fair", "Good", "Amazing"],
        color: "#3BA8A7",
      },
    ],
  },
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

const LEGACY_SYMPTOM_NAME_BY_NORMALIZED_VALUE: Record<string, string> = {
  "mood change": "moodSwings",
  anxiety: "excessiveWorry",
  fever: "temperature",
  "lungs coughing": "cough",
  "unknown pain": "pain",
};

const KEY_EVENT_FIELDS = [
  {suffix: "Newtreatment", label: "New treatment"},
  {suffix: "Changeoftreatment", label: "Change of treatment"},
  {suffix: "Changeofdose", label: "Change of dose"},
  {suffix: "Newtherapy", label: "New therapy"},
];

const normalizeLookupValue = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const validateRequest = (data: any): JournalInsightsRequest => {
  const {childId, subjectKey, symptomId, startAt, endAt, preset, folderName} =
    data ?? {};

  if (typeof childId !== "string" || !childId.trim()) {
    throw new v1.https.HttpsError("invalid-argument", "childId is required.");
  }

  if (!Object.prototype.hasOwnProperty.call(JOURNAL_CONFIG, subjectKey)) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "Unsupported journal subject."
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

  return {
    childId: childId.trim(),
    subjectKey,
    symptomId:
      typeof symptomId === "string" && symptomId.trim()
        ? symptomId.trim()
        : undefined,
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

  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveSymptomId = (subjectData: Record<string, any>): string => {
  if (typeof subjectData.symptomId === "string" && subjectData.symptomId) {
    return SYMPTOM_LABEL_BY_ID[subjectData.symptomId]
      ? subjectData.symptomId
      : "other";
  }

  const normalizedName = normalizeLookupValue(subjectData.symptomName);
  if (LEGACY_SYMPTOM_NAME_BY_NORMALIZED_VALUE[normalizedName]) {
    return LEGACY_SYMPTOM_NAME_BY_NORMALIZED_VALUE[normalizedName];
  }

  return SYMPTOM_LABEL_BY_ID[normalizedName] ? normalizedName : "other";
};

const getMatchingRecords = async (
  db: admin.database.Database,
  request: JournalInsightsRequest
): Promise<JournalRecord[]> => {
  const snapshot = await db.ref(`/journal/${request.childId}`).once("value");
  const records: JournalRecord[] = [];

  snapshot.forEach((childSnapshot) => {
    const record = childSnapshot.val() as JournalRecord | null;
    const timestamp = toNumber(record?.data?.dateTime);
    const subjectData = record?.data?.subjects?.[request.subjectKey];

    if (!record || !subjectData || timestamp === null) {
      return false;
    }

    if (timestamp < request.startAt || timestamp > request.endAt) {
      return false;
    }

    if (request.folderName && record.folder?.name !== request.folderName) {
      return false;
    }

    if (
      request.subjectKey === "symptomControl" &&
      request.symptomId &&
      resolveSymptomId(subjectData) !== request.symptomId
    ) {
      return false;
    }

    records.push({
      ...record,
      id: record.id ?? childSnapshot.key ?? undefined,
    });
    return false;
  });

  return records.sort((a, b) => {
    const aTime = toNumber(a.data?.dateTime) ?? 0;
    const bTime = toNumber(b.data?.dateTime) ?? 0;
    return aTime - bTime;
  });
};

const buildEmptySeries = (
  request: JournalInsightsRequest,
  config: JournalSubjectConfig
): JournalInsightsSeries[] =>
  config.series.map((series) => ({
    key: series.key,
    label:
      request.subjectKey === "symptomControl" && request.symptomId
        ? SYMPTOM_LABEL_BY_ID[request.symptomId] ?? "Other"
        : series.label,
    color: series.color,
    valueLabels: series.valueLabels,
    points: [],
  }));

const getKeyEvents = (
  subjectData: Record<string, any>,
  config: JournalSubjectConfig
): string[] => {
  const prefixes = new Set<string>([""]);
  config.series.forEach((series) => {
    (series.eventPrefixes ?? []).forEach((prefix) => prefixes.add(prefix));
  });
  const events: string[] = [];

  prefixes.forEach((prefix) => {
    KEY_EVENT_FIELDS.forEach((event) => {
      if (subjectData[`${prefix}${event.suffix}`] && !events.includes(event.label)) {
        events.push(event.label);
      }
    });
  });

  return events;
};

const getComment = (
  timestamp: number,
  subjectData: Record<string, any>,
  config: JournalSubjectConfig
): {timestamp: number; notes?: string} | undefined => {
  const noteKeys = new Set<string>(["notes"]);
  config.series.forEach((series) => {
    (series.notesKeys ?? []).forEach((key) => noteKeys.add(key));
  });
  const notes = [...noteKeys]
    .map((key) => subjectData[key])
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");

  return notes ? {timestamp, notes} : undefined;
};

const buildStats = (series: JournalInsightsSeries[]): JournalInsightsStat[] => {
  const stats = series.map((item) => {
    const latest = item.points[item.points.length - 1];
    return {
      key: `latest-${item.key}`,
      label: series.length > 1 ? `Latest ${item.label}` : "Latest",
      value: latest?.label ?? "No Data",
    };
  });

  stats.push({
    key: "totalReadings",
    label: "Total readings",
    value: String(Math.max(...series.map((item) => item.points.length), 0)),
  });

  return stats;
};

const buildSeriesFromRecords = (
  request: JournalInsightsRequest,
  records: JournalRecord[],
  config: JournalSubjectConfig
): {
  series: JournalInsightsSeries[];
  readings: JournalInsightsReadingRow[];
  comments: Array<{timestamp: number; notes?: string}>;
} => {
  const series = buildEmptySeries(request, config);
  const readings: JournalInsightsReadingRow[] = [];
  const comments: Array<{timestamp: number; notes?: string}> = [];

  records.forEach((record) => {
    const timestamp = toNumber(record.data?.dateTime);
    const subjectData = record.data?.subjects?.[request.subjectKey];
    if (timestamp === null || !subjectData) {
      return;
    }

    const row: JournalInsightsReadingRow = {
      timestamp,
      values: {},
      keyEvents: getKeyEvents(subjectData, config),
    };

    config.series.forEach((seriesConfig, seriesIndex) => {
      const rawValue = subjectData[seriesConfig.valueKey];
      if (typeof rawValue !== "string") {
        return;
      }

      const valueIndex = seriesConfig.valueKeys.indexOf(rawValue);
      if (valueIndex < 0) {
        return;
      }

      const point = {
        timestamp,
        value: valueIndex,
        label: seriesConfig.valueLabels[valueIndex],
      };
      series[seriesIndex].points.push(point);
      row.values[seriesConfig.key] = point.label;
    });

    if (Object.keys(row.values).length > 0) {
      readings.push(row);
    }

    const comment = getComment(timestamp, subjectData, config);
    if (comment) {
      comments.push(comment);
    }
  });

  return {series, readings, comments};
};

export const getJournalInsightsPayload = async (
  rawData: any,
  db: admin.database.Database
): Promise<JournalInsightsResponse> => {
  const request = validateRequest(rawData);
  const config = JOURNAL_CONFIG[request.subjectKey];
  const records = await getMatchingRecords(db, request);
  const {series, readings, comments} = buildSeriesFromRecords(
    request,
    records,
    config
  );
  const symptomTitle =
    request.subjectKey === "symptomControl" && request.symptomId
      ? `: ${SYMPTOM_LABEL_BY_ID[request.symptomId] ?? "Other"}`
      : "";

  return {
    subjectKey: request.subjectKey,
    symptomId: request.symptomId,
    title: `${config.title}${symptomTitle}`,
    range: {
      startAt: request.startAt,
      endAt: request.endAt,
      preset: request.preset,
    },
    series,
    stats: buildStats(series),
    readings,
    comments,
  };
};
