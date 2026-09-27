// middleware/dashboardAuth.js
//
// Guards the dashboard READ endpoints shared by the Moodle presentation layer
// and the React app (see services/moodle/dashboardAuth.js for the rules).
//
// Accepts exactly two credential kinds, and in both cases the credential's
// identity must equal the identity in the URL:
//
//   1. Moodle service credential
//        Authorization: Bearer <MOODLE_DASHBOARD_TOKEN>
//        X-Moodle-Identity:  sm_s_<studentMongoId> | sm_t_<teacherMongoId>
//        X-Moodle-Timestamp: <unix seconds (or ms)>
//        X-Moodle-Nonce:     <unique per request>
//        X-Moodle-Signature: HMAC-SHA256(token, METHOD\nPATH\nIDENTITY\nTIMESTAMP\nNONCE)
//   2. Platform session JWT (React) -> decoded.id === :id and decoded.role === role
//
// Rejections: 401 when the credential is missing/invalid/stale/replayed;
// 403 when the caller is authenticated but asks for someone else's data or for
// the wrong role's endpoints. Rejections are logged without tokens/secrets.
import jwt from "jsonwebtoken";
import logger from "../utils/logger.js";
import {
  verifyDashboardToken,
  verifyIdentityClaim,
  reserveDashboardNonce,
  dashboardAuthMode,
  maskSecret,
} from "../services/moodle/dashboardAuth.js";

const UNAUTHORIZED_CODE = "UNAUTHORIZED";
const FORBIDDEN_CODE = "FORBIDDEN";

function extractBearer(req) {
  const header = req.get ? req.get("authorization") : req.headers?.authorization;
  const value = String(header || "").trim();
  if (!value.toLowerCase().startsWith("bearer ")) return "";
  return value.slice(7).trim();
}

/**
 * Build the middleware for one protected read endpoint.
 *
 * @param {{role: "student"|"teacher", idParam: string, label?: string}} options
 */
export function dashboardReadAuth({ role, idParam, label = "dashboard" }) {
  const expectedRole = role === "teacher" ? "teacher" : "student";

  return async function dashboardReadAuthMiddleware(req, res, next) {
    const requestedId = String(req.params?.[idParam] ?? "");
    const path = String(req.originalUrl || req.url || "").split("?")[0];
    const context = {
      label,
      route: `${req.method} ${path}`,
      expectedRole,
      requestedId,
      ip: req.ip || req.socket?.remoteAddress || null,
    };

    const deny = (reason, status) => {
      logger.warn("[DASHBOARD-AUTH] rejected", { ...context, reason, status });
      if (dashboardAuthMode() === "monitor") {
        req.dashboardAuth = { kind: "monitor", role: expectedRole, reason, requestedId };
        return next();
      }
      if (status === 403) {
        return res.status(403).json({
          success: false,
          code: FORBIDDEN_CODE,
          message: "You may only access your own dashboard data.",
        });
      }
      return res.status(401).json({
        success: false,
        code: UNAUTHORIZED_CODE,
        message: "A valid Moodle bearer token or platform session token is required.",
      });
    };

    try {
      const bearer = extractBearer(req);
      if (!bearer) return deny("missing_token", 401);

      // ---- 1) Moodle service credential + signed identity claim --------------
      if (verifyDashboardToken(bearer).ok) {
        const identity = req.get("x-moodle-identity");
        const timestamp = req.get("x-moodle-timestamp");
        const nonce = req.get("x-moodle-nonce");
        const signature = req.get("x-moodle-signature");
        const claim = verifyIdentityClaim({ method: req.method, path, identity, timestamp, nonce, signature });
        logger.info("[DASHBOARD-AUTH] moodle claim", {
          ...context,
          identity,
          token: maskSecret(bearer),
          ok: claim.ok,
          reason: claim.ok ? undefined : claim.reason,
        });
        if (!claim.ok) return deny(`moodle_${claim.reason}`, 401);
        if (claim.role !== expectedRole) return deny("moodle_role_mismatch", 403);
        if (claim.platformId !== requestedId) return deny("moodle_identity_mismatch", 403);

        const single = await reserveDashboardNonce({
          nonce: String(nonce || "").trim(),
          role: claim.role,
          platformId: claim.platformId,
        });
        if (!single.ok) return deny(single.reason, 401);

        req.dashboardAuth = {
          kind: "moodle",
          role: claim.role,
          platformId: claim.platformId,
          identity: String(identity || "").toLowerCase(),
        };
        return next();
      }

      // ---- 2) Platform session JWT (React dashboard) -------------------------
      let decoded;
      try {
        decoded = jwt.verify(bearer, process.env.JWT_SECRET);
      } catch (err) {
        const reason = err?.name === "TokenExpiredError" ? "expired_jwt" : "invalid_jwt";
        logger.warn("[DASHBOARD-AUTH] token rejected", { ...context, reason, token: maskSecret(bearer) });
        return deny(reason, 401);
      }

      const jwtRole = String(decoded?.role || "").toLowerCase();
      const jwtId = String(decoded?.id ?? decoded?.userId ?? "");
      // `/api/students/login` has always minted `{ id }` tokens with NO role
      // claim, while teacher tokens carry role:"teacher". A roleless platform
      // JWT can therefore only be a student session — accept it on student
      // routes only (identity is still enforced below); teacher routes keep
      // requiring an explicit role:"teacher".
      const effectiveRole = jwtRole || "student";
      if (effectiveRole !== expectedRole) return deny("jwt_role_mismatch", 403);
      if (!jwtId || jwtId !== requestedId) return deny("jwt_identity_mismatch", 403);

      req.dashboardAuth = { kind: "jwt", role: effectiveRole, platformId: jwtId };
      return next();
    } catch (err) {
      // Never leak internals; never let an auth bug open a dashboard.
      logger.error("[DASHBOARD-AUTH] verification failure", { ...context, error: err?.message || String(err) });
      return deny("verification_error", 401);
    }
  };
}

export default dashboardReadAuth;
