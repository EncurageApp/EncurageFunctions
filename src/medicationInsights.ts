import * as admin from "firebase-admin";
import * as v1 from "firebase-functions/v1";
import moment from "moment-timezone";

export type MedicationInsightsPreset = "30D" | "90D" | "180D" | "CUSTOM";

export type MedicationInsightsRequest = {
  childId: string;
  prescriptionEventId: string;
  startAt: number;
  endAt: number;
  preset: MedicationInsightsPreset;
  timeZone?: string;
};

type Dose = {
  date?: number;
  given?: boolean;
  timeGiven?: number;
};

type Prescription = {
  name?: string;
  dose?: Record<string, unknown>;
  frequency?: Record<string, unknown>;
  reminderTimes?: number[];
  shapeAndColor?: string | null;
  conditionReason?: string | null;
  notes?: string | null;
  timeZone?: string;
  startDate?: number;
  endDate?: number;
};

type ScheduleEvent = {
  eventId?: string;
  childId?: string;
  prescriptionId?: string;
  state?: string;
  startDate?: number;
  endedAt?: number;
  completedAt?: number;
  nextScheduledDose?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_PRESETS = new Set<MedicationInsightsPreset>([
  "30D",
  "90D",
  "180D",
  "CUSTOM",
]);

const validateRequest = (raw: any): MedicationInsightsRequest => {
  const request = raw as MedicationInsightsRequest;
  if (!request?.childId || !request?.prescriptionEventId) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "childId and prescriptionEventId are required."
    );
  }
  if (
    !Number.isFinite(request.startAt) ||
    !Number.isFinite(request.endAt) ||
    request.startAt > request.endAt ||
    request.endAt > Date.now() + 60_000 ||
    request.endAt - request.startAt > DAY_MS * 181
  ) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "The report range must be between 1 and 180 days and cannot be in the future."
    );
  }
  if (!VALID_PRESETS.has(request.preset)) {
    throw new v1.https.HttpsError("invalid-argument", "Invalid preset.");
  }
  return request;
};

const statusFor = (state?: string): "active" | "paused" | "past" => {
  if (state === "paused") return "paused";
  if (state === "ended" || state === "completed") return "past";
  return "active";
};

const effectiveEndFor = (
  event: ScheduleEvent,
  prescription: Prescription,
  doses: Dose[]
): number | undefined => {
  if (event.state === "ended" && Number.isFinite(event.endedAt)) {
    return event.endedAt;
  }
  if (event.state === "completed" && Number.isFinite(event.completedAt)) {
    return event.completedAt;
  }
  if (Number.isFinite(prescription.endDate)) return prescription.endDate;
  if (event.state !== "ended" && event.state !== "completed") return undefined;
  const dates = doses
    .map((dose) => dose.date)
    .filter((date): date is number => Number.isFinite(date));
  return dates.length ? Math.max(...dates) : undefined;
};

export const buildMedicationInsightsResponse = ({
  request,
  event,
  prescription,
  doses,
  now = Date.now(),
}: {
  request: MedicationInsightsRequest;
  event: ScheduleEvent;
  prescription: Prescription;
  doses: Dose[];
  now?: number;
}) => {
  const timeZone = prescription.timeZone || request.timeZone || "UTC";
  const first = moment.tz(request.startAt, timeZone).startOf("day");
  const last = moment.tz(request.endAt, timeZone).startOf("day");
  const days: Array<{
    dateKey: string;
    scheduledDoses: number;
    givenDoses: number;
    futureDoses: number;
    state: "full" | "partial" | "none-given" | "no-scheduled";
    tooltipKind?: "no-scheduled-yet";
  }> = [];
  for (
    let cursor = first.clone();
    cursor.isSameOrBefore(last, "day");
    cursor.add(1, "day")
  ) {
    days.push({
      dateKey: cursor.format("YYYY-MM-DD"),
      scheduledDoses: 0,
      givenDoses: 0,
      futureDoses: 0,
      state: "no-scheduled",
    });
  }
  const byDate = new Map(days.map((day) => [day.dateKey, day]));
  const administeredDoses: Array<{scheduledDate: number; timeGiven: number}> = [];
  const doseHistory: Array<{
    scheduledDate: number;
    given: boolean;
    timeGiven?: number;
  }> = [];

  doses.forEach((dose) => {
    if (!Number.isFinite(dose.date)) return;
    const date = dose.date as number;
    const day = byDate.get(moment.tz(date, timeZone).format("YYYY-MM-DD"));
    if (!day) return;
    if (date > now) {
      day.futureDoses += 1;
      return;
    }
    day.scheduledDoses += 1;
    doseHistory.push({
      scheduledDate: date,
      given: dose.given === true,
      ...(Number.isFinite(dose.timeGiven)
        ? {timeGiven: dose.timeGiven as number}
        : {}),
    });
    if (dose.given === true) {
      day.givenDoses += 1;
      if (Number.isFinite(dose.timeGiven)) {
        administeredDoses.push({
          scheduledDate: date,
          timeGiven: dose.timeGiven as number,
        });
      }
    }
  });

  if (
    event.state === "active" &&
    Number.isFinite(event.nextScheduledDose) &&
    (event.nextScheduledDose as number) > now
  ) {
    const key = moment
      .tz(event.nextScheduledDose as number, timeZone)
      .format("YYYY-MM-DD");
    const day = byDate.get(key);
    if (day && day.futureDoses === 0) day.futureDoses = 1;
  }

  days.forEach((day) => {
    if (day.scheduledDoses === 0) {
      day.state = "no-scheduled";
      if (day.futureDoses > 0) day.tooltipKind = "no-scheduled-yet";
    } else if (day.givenDoses === 0) {
      day.state = "none-given";
    } else if (day.givenDoses >= day.scheduledDoses) {
      day.state = "full";
    } else {
      day.state = "partial";
    }
  });

  const scheduledDoses = days.reduce((sum, day) => sum + day.scheduledDoses, 0);
  const givenDoses = days.reduce((sum, day) => sum + day.givenDoses, 0);

  return {
    schedule: {
      eventId: event.eventId || request.prescriptionEventId,
      status: statusFor(event.state),
      name: prescription.name || "",
      dose: prescription.dose || {},
      frequency: prescription.frequency || {},
      reminderTimes: prescription.reminderTimes || [],
      shapeAndColor: prescription.shapeAndColor,
      conditionReason: prescription.conditionReason,
      notes: prescription.notes,
      timeZone,
      startAt: prescription.startDate || event.startDate || 0,
      effectiveEndAt: effectiveEndFor(event, prescription, doses),
    },
    range: {
      startAt: request.startAt,
      endAt: request.endAt,
      preset: request.preset,
    },
    days,
    totals: {
      scheduledDoses,
      givenDoses,
      adherencePercent:
        scheduledDoses === 0 ? 0 : Math.round((givenDoses / scheduledDoses) * 100),
    },
    administeredDoses: administeredDoses.sort(
      (a, b) => a.timeGiven - b.timeGiven
    ),
    doseHistory: doseHistory.sort(
      (a, b) => a.scheduledDate - b.scheduledDate
    ),
    unavailableReason: doses.length === 0 ? "no-dose-history" : undefined,
  };
};

export const getMedicationInsightsPayload = async (
  rawData: any,
  db: admin.database.Database
) => {
  const request = validateRequest(rawData);
  const eventSnapshot = await db
    .ref(`prescription_events/${request.prescriptionEventId}`)
    .once("value");
  const event = eventSnapshot.val() as ScheduleEvent | null;
  if (!event || event.childId !== request.childId || !event.prescriptionId) {
    throw new v1.https.HttpsError("not-found", "Medication schedule not found.");
  }
  const [prescriptionSnapshot, dosesSnapshot] = await Promise.all([
    db.ref(`prescription/${event.prescriptionId}`).once("value"),
    db
      .ref("prescription_doses")
      .orderByChild("prescriptionEventId")
      .equalTo(request.prescriptionEventId)
      .once("value"),
  ]);
  const prescription = prescriptionSnapshot.val() as Prescription | null;
  if (!prescription) {
    throw new v1.https.HttpsError("not-found", "Prescription not found.");
  }
  const timeZone = prescription.timeZone || request.timeZone || "UTC";
  const inclusiveDays =
    moment.tz(request.endAt, timeZone).startOf("day").diff(
      moment.tz(request.startAt, timeZone).startOf("day"),
      "days"
    ) + 1;
  if (inclusiveDays < 1 || inclusiveDays > 180) {
    throw new v1.https.HttpsError(
      "invalid-argument",
      "The report range must contain between 1 and 180 calendar days."
    );
  }
  const doses = Object.values((dosesSnapshot.val() || {}) as Record<string, Dose>);
  return buildMedicationInsightsResponse({
    request,
    event: {...event, eventId: event.eventId || request.prescriptionEventId},
    prescription,
    doses,
  });
};
