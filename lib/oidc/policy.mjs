/**
 * lib/oidc/policy.mjs
 *
 * oidc-provider keeps its own session cookie (14 days) next to the Zander web
 * session. With the default policy, once that provider session exists every
 * later /oidc/auth from the same browser is answered silently, without ever
 * reaching our interaction page, so it never re-checks who is logged in to
 * Zander. Logging out of Zander, or a different person logging in on a shared
 * machine, would still get codes for the first account.
 *
 * The extra login check below sends every authorization request through the
 * interaction (routes/oidcRoutes.js), which reads req.session.user. The only
 * exception is the resume right after that interaction finished a login, or
 * the request would loop.
 */

import { interactionPolicy } from "oidc-provider";

const { base, Check } = interactionPolicy;

export function requireZanderSessionCheck(ctx) {
  return ctx?.oidc?.result?.login ? Check.NO_NEED_TO_PROMPT : Check.REQUEST_PROMPT;
}

export function buildInteractionPolicy() {
  const policy = base();
  policy.get("login").checks.add(
    new Check(
      "zander_session",
      "Every sign-in is confirmed against the current Zander login",
      "login_required",
      requireZanderSessionCheck
    )
  );
  return policy;
}
