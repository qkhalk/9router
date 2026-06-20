// Audit log helper. Wrap a route handler with withAudit() to automatically
// record the action once it (optionally) returns successfully. Failures are
// recorded with afterData={ error } so admin can see why a sensitive op
// flopped without us masking the cause.
import * as auditLogsRepo from "@/lib/db/repos/auditLogsRepo.js";

export const AUDIT_ACTIONS = {
  AUTH_LOGIN_SUCCESS: "auth.login.success",
  AUTH_LOGIN_FAIL: "auth.login.fail",
  AUTH_REGISTER: "auth.register",
  AUTH_REGISTER_FAIL: "auth.register.fail",
  AUTH_VERIFY_OTP: "auth.verify_otp",
  AUTH_VERIFY_OTP_FAIL: "auth.verify_otp.fail",
  AUTH_RESEND_OTP: "auth.resend_otp",
  AUTH_FORGOT_PASSWORD: "auth.forgot_password",
  AUTH_LOGOUT: "auth.logout",
  AUTH_VIEW_REQUEST_CONTENT: "auth.view_request_content",
};

function resolveActorUserId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (value.user?.id) return value.user.id;
    if (value.session?.userId) return value.session.userId;
    if (value.userId) return value.userId;
  }
  return null;
}

export async function audit({ actorUserId = null, action, entityType = null, entityId = null, beforeData = null, afterData = null, request = null }) {
  try {
    return await auditLogsRepo.createAuditLog({
      actorUserId: resolveActorUserId(actorUserId),
      action,
      entityType,
      entityId,
      beforeData,
      afterData,
      ipAddress: request?.headers?.get?.("x-9r-real-ip") || null,
      userAgent: request?.headers?.get?.("user-agent") || null,
    });
  } catch (e) {
    // Audit must never break the primary action. Log + swallow.
    console.warn(`[audit] failed to record ${action}: ${e?.message || e}`);
    return null;
  }
}

// Helper for route handlers. `detailsBuilder` is called with the handler's
// return value to produce a structured detail blob (e.g. { userId, success }).
export function withAudit(action, handler, { detailsBuilder, actorFrom } = {}) {
  return async function audited(request, ctx) {
    const result = await handler(request, ctx);
    try {
      let actorUserId = null;
      if (typeof actorFrom === "function") actorUserId = actorFrom(result, request);
      else if (result && typeof result === "object") {
        actorUserId = resolveActorUserId(result.user || result.session || result);
      }
      const details = typeof detailsBuilder === "function" ? detailsBuilder(result, request) : null;
      await audit({
        actorUserId,
        action,
        request,
        afterData: details,
      });
    } catch (e) {
      console.warn(`[audit] withAudit handler for ${action} failed: ${e?.message || e}`);
    }
    return result;
  };
}
