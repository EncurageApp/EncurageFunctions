import moment from "moment-timezone";

export const MINUTE_MS = 60_000;
export const TERMINAL_SEND_GRACE_MS = 5 * MINUTE_MS;

export type NotificationStage = 0 | 1 | 2 | 3 | 4;

export type DueStage = {
  stage: NotificationStage;
  dueAt: number;
  nextNotificationTime: number | null;
  nextNotificationCount: number | null;
  supersededStages: NotificationStage[];
};

const defaultIntervalsAfterStage: Record<0 | 1 | 2 | 3, number> = {
  0: 10,
  1: 10,
  2: 25,
  3: 15,
};

const intervalAfterStage = (
  stage: NotificationStage,
  snoozeInterval?: number
): number => {
  if (stage >= 4) return 0;
  if (stage === 0) return 10;
  return snoozeInterval || defaultIntervalsAfterStage[stage as 1 | 2 | 3];
};

const nextStageTime = (
  dueAt: number,
  stage: NotificationStage,
  snoozeInterval?: number
): number => dueAt + intervalAfterStage(stage, snoozeInterval) * MINUTE_MS;

export function resolveDueStage(event: any, now: number): DueStage | null {
  const scheduledDose = Number(event.nextScheduledDose);
  if (!Number.isFinite(scheduledDose)) return null;

  let stage: NotificationStage;
  let dueAt: number;

  if (
    Number.isFinite(Number(event.nextNotificationTime)) &&
    Number(event.notificationCount) >= 1 &&
    Number(event.notificationCount) <= 4
  ) {
    stage = Number(event.notificationCount) as NotificationStage;
    dueAt = Number(event.nextNotificationTime);
  } else {
    stage = 0;
    dueAt = scheduledDose;
  }

  if (dueAt > now) return null;

  const supersededStages: NotificationStage[] = [];
  while (stage < 4) {
    const followingDueAt = nextStageTime(
      dueAt,
      stage,
      event.snoozeInterval
    );
    if (followingDueAt > now) break;
    supersededStages.push(stage);
    stage = (stage + 1) as NotificationStage;
    dueAt = followingDueAt;
  }

  if (stage === 4) {
    return {
      stage,
      dueAt,
      nextNotificationTime: null,
      nextNotificationCount: null,
      supersededStages,
    };
  }

  return {
    stage,
    dueAt,
    nextNotificationTime: nextStageTime(
      dueAt,
      stage,
      event.snoozeInterval
    ),
    nextNotificationCount: stage + 1,
    supersededStages,
  };
}

const ensureBeforeEnd = (candidate: number, endDate?: number): number => {
  if (typeof endDate === "number" && candidate > endDate) {
    throw new Error("No next dose: next occurrence would be after end date.");
  }
  return candidate;
};

export function calculateNextDoseAfter(
  prescription: any,
  previousScheduledDose: number,
  backupTimeZone?: string
): number {
  const {frequency, startDate, reminderTimes} = prescription || {};
  if (!frequency?.type) throw new Error("Frequency type is required.");
  if (startDate == null) throw new Error("startDate is required.");

  const timeZone = prescription.timeZone || backupTimeZone || "UTC";
  const endDate =
    typeof prescription.endDate === "number" ? prescription.endDate : undefined;
  const start = moment.tz(Number(startDate), timeZone);
  const previous = moment.tz(previousScheduledDose, timeZone);
  const toTime = (value: number) => {
    const normalized = Math.max(0, Math.min(value, 86_399_999));
    return {
      hour: Math.floor(normalized / 3_600_000),
      minute: Math.floor((normalized % 3_600_000) / 60_000),
    };
  };

  switch (frequency.type) {
    case "hourly": {
      const hours = Number(frequency.interval);
      if (!hours || hours < 1 || hours > 12) {
        throw new Error("HOURLY requires interval 1-12.");
      }
      const anchor = Number(frequency.startDate ?? startDate);
      const interval = hours * 60 * MINUTE_MS;
      const steps = Math.floor((previousScheduledDose - anchor) / interval) + 1;
      return ensureBeforeEnd(anchor + Math.max(1, steps) * interval, endDate);
    }
    case "daily": {
      const count = Number(frequency.interval);
      if (!count || !Array.isArray(reminderTimes) || !reminderTimes.length) {
        throw new Error("DAILY requires interval and reminderTimes.");
      }
      const times = [...reminderTimes]
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
        .slice(0, count);
      for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
        const day = previous.clone().startOf("day").add(dayOffset, "day");
        for (const reminderTime of times) {
          const {hour, minute} = toTime(reminderTime);
          const candidate = day
            .clone()
            .hour(hour)
            .minute(minute)
            .second(0)
            .millisecond(0);
          if (candidate.isAfter(previous) && candidate.isSameOrAfter(start)) {
            return ensureBeforeEnd(candidate.valueOf(), endDate);
          }
        }
      }
      break;
    }
    case "certain_days": {
      const days = frequency.daysOfWeek as number[] | undefined;
      if (!Array.isArray(days) || !days.length) {
        throw new Error("CERTAIN_DAYS requires daysOfWeek.");
      }
      if (!Array.isArray(reminderTimes) || !reminderTimes.length) {
        throw new Error("CERTAIN_DAYS requires reminderTimes.");
      }
      const allowedDays = [...new Set(days)].sort((a, b) => a - b);
      const times = [...reminderTimes].filter(Number.isFinite).sort((a, b) => a - b);
      for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const day = previous.clone().startOf("day").add(dayOffset, "day");
        if (!allowedDays.includes(day.day())) continue;
        for (const reminderTime of times) {
          const {hour, minute} = toTime(reminderTime);
          const candidate = day
            .clone()
            .hour(hour)
            .minute(minute)
            .second(0)
            .millisecond(0);
          if (candidate.isAfter(previous) && candidate.isSameOrAfter(start)) {
            return ensureBeforeEnd(candidate.valueOf(), endDate);
          }
        }
      }
      break;
    }
    case "weekly":
    case "once_a_week": {
      const weeks =
        frequency.type === "once_a_week" ? 1 : Number(frequency.interval);
      if (!weeks || !Array.isArray(reminderTimes) || reminderTimes.length !== 1) {
        throw new Error("WEEKLY requires interval and one reminderTime.");
      }
      const {hour, minute} = toTime(reminderTimes[0]);
      const anchorWeek = start.clone().startOf("week");
      const previousWeek = previous.clone().startOf("week");
      const weeksSince = previousWeek.diff(anchorWeek, "weeks");
      const nextAlignedWeek =
        Math.floor(weeksSince / weeks) * weeks +
        (weeksSince % weeks === 0 ? 0 : weeks - (weeksSince % weeks));
      const build = (weekOffset: number) =>
        anchorWeek
          .clone()
          .add(weekOffset, "weeks")
          .day(start.day())
          .hour(hour)
          .minute(minute)
          .second(0)
          .millisecond(0);
      let candidate = build(nextAlignedWeek);
      if (!candidate.isAfter(previous)) candidate = build(nextAlignedWeek + weeks);
      return ensureBeforeEnd(candidate.valueOf(), endDate);
    }
    case "every_other_day": {
      if (!Array.isArray(reminderTimes) || reminderTimes.length !== 1) {
        throw new Error("EVERY_OTHER_DAY requires one reminderTime.");
      }
      const {hour, minute} = toTime(reminderTimes[0]);
      const anchorDay = start.clone().startOf("day");
      let candidateDay = previous.clone().startOf("day");
      for (let offset = 0; offset <= 2; offset++) {
        const day = candidateDay.clone().add(offset, "day");
        const daysSince = day.diff(anchorDay, "days");
        if (((daysSince % 2) + 2) % 2 !== 0) continue;
        const candidate = day
          .hour(hour)
          .minute(minute)
          .second(0)
          .millisecond(0);
        if (candidate.isAfter(previous)) {
          return ensureBeforeEnd(candidate.valueOf(), endDate);
        }
      }
      break;
    }
    case "monthly": {
      const months = Number(frequency.interval);
      if (!months || !Array.isArray(reminderTimes) || reminderTimes.length !== 1) {
        throw new Error("MONTHLY requires interval and one reminderTime.");
      }
      const {hour, minute} = toTime(reminderTimes[0]);
      const anchorMonth = start.clone().startOf("month");
      const previousMonth = previous.clone().startOf("month");
      const monthsSince = previousMonth.diff(anchorMonth, "months");
      const remainder = ((monthsSince % months) + months) % months;
      const alignedMonth = monthsSince + (remainder === 0 ? 0 : months - remainder);
      const build = (monthOffset: number) => {
        const month = anchorMonth.clone().add(monthOffset, "months");
        return month
          .date(Math.min(start.date(), month.daysInMonth()))
          .hour(hour)
          .minute(minute)
          .second(0)
          .millisecond(0);
      };
      let candidate = build(alignedMonth);
      if (!candidate.isAfter(previous)) candidate = build(alignedMonth + months);
      return ensureBeforeEnd(candidate.valueOf(), endDate);
    }
    default:
      throw new Error(`Unsupported frequency type: ${frequency.type}`);
  }

  throw new Error(`Unable to calculate next dose for ${frequency.type}.`);
}
