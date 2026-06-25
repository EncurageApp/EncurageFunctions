import * as admin from "firebase-admin";
import * as v1 from "firebase-functions/v1";

export type TherapyInsightsPreset = "1W" | "4W" | "12W" | "CUSTOM";
export type TherapyInsightsTherapyKey =
  | "speechTherapy"
  | "occupationalTherapy"
  | "physicalTherapy"
  | "emotionalTherapy"
  | "behavioralTherapy"
  | "artTherapy"
  | "dramaTherapy"
  | "playTherapy"
  | "petTherapy"
  | "phototherapy"
  | "digitalTherapeutics";
export type TherapySessionRating = "bad" | "notGreat" | "ok" | "good" | "amazing";
export type TherapyHelpfulness =
  | "unhelpful"
  | "somewhatHelpful"
  | "veryHelpful"
  | "extremelyHelpful"
  | "other";

export type TherapyInsightsRequest = {
  childId: string;
  therapyKey: TherapyInsightsTherapyKey;
  startAt: number;
  endAt: number;
  preset: TherapyInsightsPreset;
  folderName?: string;
};

type TherapyInsightsPoint = {
  timestamp: number;
  value: number;
  label: string;
};

type TherapyInsightsSeries = {
  key: string;
  label: string;
  color: string;
  points: TherapyInsightsPoint[];
};

type TherapyInsightsStat = {
  key:
    | "latestSession"
    | "highestSession"
    | "latestHelpfulness"
    | "highestHelpfulness"
    | "totalReadings";
  value: string;
};

type TherapyInsightsFieldCoverage = {
  totalEntries: number;
  recordedEntries: number;
  missingEntries: number;
};

type TherapyInsightsOtherHelpfulnessEntry = {
  timestamp: number;
  label: string;
};

export type TherapyInsightsResponse = {
  kind: "therapy";
  trackingType: "therapies";
  therapyKey: TherapyInsightsTherapyKey;
  title: string;
  range: {
    startAt: number;
    endAt: number;
    preset: TherapyInsightsPreset;
  };
  howWasSessionSeries: TherapyInsightsSeries;
  helpfulnessSeries: TherapyInsightsSeries;
  coverage: {
    howWasSession: TherapyInsightsFieldCoverage;
    helpfulness: TherapyInsightsFieldCoverage;
  };
  otherHelpfulnessEntries?: TherapyInsightsOtherHelpfulnessEntry[];
  stats: TherapyInsightsStat[];
  comments?: Array<{
    timestamp: number;
    notes?: string;
    conditionReason?: string;
  }>;
};

type TrackingRecord = {
  id?: string;
  trackingType?: string;
  category?: string;
  folder?: {
    name?: string;
  };
  data?: {
    dateTime?: string | number;
    howWasSession?: string;
    helpfulness?: string;
    helpfulnessOther?: string;
    notes?: string;
    conditionReason?: string;
  };
};

type MatchingTherapyEntry = {
  timestamp: number;
  item: NonNullable<TrackingRecord["data"]>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = DAY_MS * 84;

const THERAPY_KEYS: TherapyInsightsTherapyKey[] = [
  "speechTherapy",
  "occupationalTherapy",
  "physicalTherapy",
  "emotionalTherapy",
  "behavioralTherapy",
  "artTherapy",
  "dramaTherapy",
  "playTherapy",
  "petTherapy",
  "phototherapy",
  "digitalTherapeutics",
];

const THERAPY_LABEL_BY_KEY: Record<TherapyInsightsTherapyKey, string> = {
  speechTherapy: "Speech Therapy",
  occupationalTherapy: "Occupational Therapy",
  physicalTherapy: "Physical Therapy",
  emotionalTherapy: "Emotional Therapy",
  behavioralTherapy: "Behavioral Therapy",
  artTherapy: "Art Therapy",
  dramaTherapy: "Drama Therapy",
  playTherapy: "Play Therapy",
  petTherapy: "Pet Therapy",
  phototherapy: "Phototherapy",
  digitalTherapeutics: "Digital Therapeutics",
};

const THERAPY_KEY_BY_NORMALIZED_VALUE: Record<string, TherapyInsightsTherapyKey> = {
  speechtherapy: "speechTherapy",
  occupationaltherapy: "occupationalTherapy",
  physicaltherapy: "physicalTherapy",
  emotionaltherapy: "emotionalTherapy",
  behavioraltherapy: "behavioralTherapy",
  arttherapy: "artTherapy",
  dramatherapy: "dramaTherapy",
  playtherapy: "playTherapy",
  pettherapy: "petTherapy",
  phototherapy: "phototherapy",
  digitaltherapeutics: "digitalTherapeutics",
};

const THERAPY_INSIGHTS_COLORS = {
  howWasSession: "#3448F0",
  helpfulness: "#3BA8A7",
};

const SESSION_SCORE_BY_VALUE: Record<TherapySessionRating, number> = {
  bad: 1,
  notGreat: 2,
  ok: 3,
  good: 4,
  amazing: 5,
};

const SESSION_LABEL_BY_VALUE: Record<TherapySessionRating, string> = {
  bad: "Bad",
  notGreat: "Not Great",
  ok: "Ok",
  good: "Good",
  amazing: "Amazing",
};

const HELPFULNESS_SCORE_BY_VALUE: Record<
  Exclude<TherapyHelpfulness, "other">,
  number
> = {
  unhelpful: 1,
  somewhatHelpful: 2,
  veryHelpful: 3,
  extremelyHelpful: 4,
};

const HELPFULNESS_LABEL_BY_VALUE: Record<
  Exclude<TherapyHelpfulness, "other">,
  string
> = {
  unhelpful: "Unhelpful",
  somewhatHelpful: "Somewhat helpful",
  veryHelpful: "Very helpful",
  extremelyHelpful: "Extremely helpful",
};

const normalizeCategoryValue = (value: unknown): TherapyInsightsTherapyKey | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return THERAPY_KEY_BY_NORMALIZED_VALUE[normalized];
};

const validateRequest = (data: any): TherapyInsightsRequest => {
  const {childId, therapyKey, startAt, endAt, preset, folderName} = data ?? {};
  const normalizedTherapyKey = normalizeCategoryValue(therapyKey);

  if (typeof childId !== "string" || !childId.trim()) {
    throw new v1.https.HttpsError("invalid-argument", "childId is required.");
  }

  if (!normalizedTherapyKey || !THERAPY_KEYS.includes(normalizedTherapyKey)) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "therapyKey must be a supported therapy."
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
    therapyKey: normalizedTherapyKey,
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

const fetchTrackingRecords = async (
  db: admin.database.Database,
  request: TherapyInsightsRequest
): Promise<TrackingRecord[]> => {
  const snapshot = await db
    .ref(`/tracking/${request.childId}`)
    .orderByChild("trackingType")
    .equalTo("therapies")
    .once("value");
  const records: TrackingRecord[] = [];

  snapshot.forEach((childSnapshot) => {
    const record = childSnapshot.val() as TrackingRecord | null;

    if (
      record?.trackingType === "therapies" &&
      (!request.folderName || record.folder?.name === request.folderName)
    ) {
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
  request: TherapyInsightsRequest
): MatchingTherapyEntry[] =>
  records
    .flatMap((record) => {
      if (normalizeCategoryValue(record.category) !== request.therapyKey) {
        return [];
      }

      if (!record.data) {
        return [];
      }

      const timestamp = toNumber(record.data.dateTime);

      if (
        timestamp === null ||
        timestamp < request.startAt ||
        timestamp > request.endAt
      ) {
        return [];
      }

      return [{timestamp, item: record.data}];
    })
    .sort((a, b) => a.timestamp - b.timestamp);

const getFieldCoverage = (
  totalEntries: number,
  recordedEntries: number
): TherapyInsightsFieldCoverage => ({
  totalEntries,
  recordedEntries,
  missingEntries: Math.max(0, totalEntries - recordedEntries),
});

const getOrdinalStats = (
  sessionPoints: TherapyInsightsPoint[],
  helpfulnessPoints: TherapyInsightsPoint[]
): TherapyInsightsStat[] => {
  const stats: TherapyInsightsStat[] = [];

  if (sessionPoints.length > 0) {
    const highestSession = [...sessionPoints].sort((a, b) => b.value - a.value)[0];
    const latestSession = sessionPoints[sessionPoints.length - 1];

    stats.push(
      {key: "latestSession", value: latestSession.label},
      {key: "highestSession", value: highestSession.label}
    );
  }

  if (helpfulnessPoints.length > 0) {
    const highestHelpfulness = [...helpfulnessPoints].sort(
      (a, b) => b.value - a.value
    )[0];
    const latestHelpfulness = helpfulnessPoints[helpfulnessPoints.length - 1];

    stats.push(
      {key: "latestHelpfulness", value: latestHelpfulness.label},
      {key: "highestHelpfulness", value: highestHelpfulness.label}
    );
  }

  stats.push({
    key: "totalReadings",
    value: String(Math.max(sessionPoints.length, helpfulnessPoints.length)),
  });

  return stats;
};

const getComments = (entries: MatchingTherapyEntry[]) =>
  entries
    .map(({timestamp, item}) => ({
      timestamp,
      notes: item.notes,
      conditionReason: item.conditionReason,
    }))
    .filter(
      (comment) =>
        typeof comment.notes === "string" ||
        typeof comment.conditionReason === "string"
    );

const buildResponse = (
  request: TherapyInsightsRequest,
  matchingEntries: MatchingTherapyEntry[]
): TherapyInsightsResponse => {
  const howWasSessionPoints: TherapyInsightsPoint[] = matchingEntries.flatMap(
    ({timestamp, item}) => {
      const rating = item.howWasSession as TherapySessionRating | undefined;

      if (!rating || SESSION_SCORE_BY_VALUE[rating] === undefined) {
        return [];
      }

      return [
        {
          timestamp,
          value: SESSION_SCORE_BY_VALUE[rating],
          label: SESSION_LABEL_BY_VALUE[rating],
        },
      ];
    }
  );
  const helpfulnessPoints: TherapyInsightsPoint[] = matchingEntries.flatMap(
    ({timestamp, item}) => {
      const helpfulness = item.helpfulness as TherapyHelpfulness | undefined;

      if (!helpfulness || HELPFULNESS_SCORE_BY_VALUE[helpfulness] === undefined) {
        return [];
      }

      return [
        {
          timestamp,
          value: HELPFULNESS_SCORE_BY_VALUE[helpfulness],
          label: HELPFULNESS_LABEL_BY_VALUE[helpfulness],
        },
      ];
    }
  );
  const otherHelpfulnessEntries = matchingEntries.flatMap(
    ({timestamp, item}) => {
      if (item.helpfulness !== "other") {
        return [];
      }

      return [
        {
          timestamp,
          label:
            typeof item.helpfulnessOther === "string" &&
            item.helpfulnessOther.trim()
              ? item.helpfulnessOther.trim()
              : "Other",
        },
      ];
    }
  );
  const totalEntries = matchingEntries.length;
  const recordedHelpfulnessEntries =
    helpfulnessPoints.length + otherHelpfulnessEntries.length;

  return {
    kind: "therapy",
    trackingType: "therapies",
    therapyKey: request.therapyKey,
    title: THERAPY_LABEL_BY_KEY[request.therapyKey],
    range: {
      startAt: request.startAt,
      endAt: request.endAt,
      preset: request.preset,
    },
    howWasSessionSeries: {
      key: "howWasSession",
      label: "How was the session",
      color: THERAPY_INSIGHTS_COLORS.howWasSession,
      points: howWasSessionPoints,
    },
    helpfulnessSeries: {
      key: "helpfulness",
      label: "How helpful was the session",
      color: THERAPY_INSIGHTS_COLORS.helpfulness,
      points: helpfulnessPoints,
    },
    coverage: {
      howWasSession: getFieldCoverage(totalEntries, howWasSessionPoints.length),
      helpfulness: getFieldCoverage(totalEntries, recordedHelpfulnessEntries),
    },
    otherHelpfulnessEntries,
    stats: getOrdinalStats(howWasSessionPoints, helpfulnessPoints),
    comments: getComments(matchingEntries),
  };
};

export const getTherapyInsightsPayload = async (
  rawData: any,
  db: admin.database.Database
): Promise<TherapyInsightsResponse> => {
  const request = validateRequest(rawData);
  const records = await fetchTrackingRecords(db, request);
  const matchingEntries = getMatchingEntries(records, request);

  return buildResponse(request, matchingEntries);
};
