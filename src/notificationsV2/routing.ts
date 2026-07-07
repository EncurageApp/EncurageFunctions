import {createHash} from "crypto";
import {
  notificationV2CanaryEnabled,
  notificationV2CanaryUids,
} from "./config";

export type NotificationV2RouteReason =
  | "disabled"
  | "kill_switch"
  | "canary"
  | "all"
  | "percentage"
  | "not_selected";

export type NotificationV2Route = {
  useV2: boolean;
  reason: NotificationV2RouteReason;
  bucket?: number;
};

type RolloutMode = "canary" | "percentage" | "all";

const parseRolloutMode = (value?: string): RolloutMode => {
  const normalized = String(value || "canary").trim().toLowerCase();
  if (normalized === "percentage" || normalized === "all") {
    return normalized;
  }
  return "canary";
};

const parseRolloutPercent = (value?: string): number => {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(100, Math.max(0, parsed));
};

export const notificationV2KillSwitch =
  process.env.NOTIFICATION_V2_KILL_SWITCH === "true";

export const notificationV2RolloutMode = parseRolloutMode(
  process.env.NOTIFICATION_V2_ROLLOUT_MODE
);

export const notificationV2RolloutPercent = parseRolloutPercent(
  process.env.NOTIFICATION_V2_ROLLOUT_PERCENT
);

export const notificationV2RoutingEnabled =
  notificationV2CanaryEnabled && !notificationV2KillSwitch;

export const notificationV2UsesStaticCanaryOnly =
  notificationV2RolloutMode === "canary" ||
  (notificationV2RolloutMode === "percentage" &&
    notificationV2RolloutPercent === 0);

export const notificationV2Bucket = (uid: string): number => {
  const hash = createHash("sha256").update(uid).digest("hex");
  return parseInt(hash.slice(0, 8), 16) % 10_000;
};

export const getNotificationV2Route = (uid?: string): NotificationV2Route => {
  if (!notificationV2CanaryEnabled) return {useV2: false, reason: "disabled"};
  if (notificationV2KillSwitch) return {useV2: false, reason: "kill_switch"};
  if (typeof uid !== "string" || !uid) {
    return {useV2: false, reason: "not_selected"};
  }
  if (notificationV2CanaryUids.has(uid)) return {useV2: true, reason: "canary"};
  if (notificationV2RolloutMode === "all") return {useV2: true, reason: "all"};
  if (notificationV2RolloutMode === "percentage") {
    const bucket = notificationV2Bucket(uid);
    const threshold = Math.floor(notificationV2RolloutPercent * 100);
    return bucket < threshold ?
      {useV2: true, reason: "percentage", bucket} :
      {useV2: false, reason: "not_selected", bucket};
  }
  return {useV2: false, reason: "not_selected"};
};

export const isNotificationV2Owner = (uid?: string): boolean =>
  getNotificationV2Route(uid).useV2;
