import { AppError } from "./errors.js";

/**
 * A report action is only meaningful for the target it was filed against.
 * Keeping this matrix outside the route makes the rule easy to test and keeps
 * future moderation entry points from inventing a broader action surface.
 */
export const REPORT_ACTION_TARGETS = Object.freeze({
  NONE: Object.freeze(["STUDENT", "GROUP", "MESSAGE", "RESOURCE"]),
  WARN_USER: Object.freeze(["STUDENT"]),
  SUSPEND_USER: Object.freeze(["STUDENT"]),
  REMOVE_CONTENT: Object.freeze(["MESSAGE", "RESOURCE"]),
  REMOVE_GROUP: Object.freeze(["GROUP"]),
});

export function isReportActionTargetCompatible(action, targetType) {
  return REPORT_ACTION_TARGETS[action]?.includes(targetType) ?? false;
}

export function assertReportActionTarget(action, targetType) {
  if (isReportActionTargetCompatible(action, targetType)) return;

  throw new AppError("That moderation action cannot be applied to this report target.", {
    status: 422,
    code: "INVALID_REPORT_ACTION_TARGET",
    fields: { action: "Choose an action that matches the reported item." },
  });
}

/**
 * A report can be moved into the review queue without taking action. Any
 * moderation action, however, is a resolution and must not leave the report in
 * an apparently open state. Dismissal also cannot carry a moderation action.
 */
export function assertReportResolution(status, action) {
  if (action === "NONE") return;

  if (status !== "RESOLVED") {
    throw new AppError("A moderation action must resolve the report.", {
      status: 422,
      code: "INVALID_REPORT_RESOLUTION",
      fields: { status: "Use RESOLVED when applying a moderation action." },
    });
  }
}

export default {
  REPORT_ACTION_TARGETS,
  isReportActionTargetCompatible,
  assertReportActionTarget,
  assertReportResolution,
};
