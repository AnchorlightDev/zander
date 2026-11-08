/**
 * lib/turnstile.mjs
 *
 * Cloudflare Turnstile verification for public, unauthenticated forms (the
 * contact form is the first caller). Turnstile is a mostly-invisible CAPTCHA:
 * the browser widget produces a token, and the server exchanges that token with
 * Cloudflare here to confirm a human (or at least a browser) sent the form.
 *
 * Graceful rollout: with no keys configured, verification is SKIPPED rather than
 * failing closed, so deploying this code does not take the form offline before
 * the keys are added to .env. Add TURNSTILE_SITE_KEY (public, rendered into the
 * page) and TURNSTILE_SECRET_KEY (private) to switch protection on; the widget
 * and this check both light up automatically.
 *
 * No DB import, so it is unit-testable; the one network call is injectable.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The public site key, or null when Turnstile is not configured. */
export function turnstileSiteKey() {
  const key = String(process.env.TURNSTILE_SITE_KEY ?? "").trim();
  return key || null;
}

/** True once both keys are present -- i.e. the widget should render and tokens be checked. */
export function isTurnstileEnabled() {
  return Boolean(turnstileSiteKey() && String(process.env.TURNSTILE_SECRET_KEY ?? "").trim());
}

/**
 * Verify a Turnstile token with Cloudflare.
 *
 * @param {string} token       The `cf-turnstile-response` value from the form.
 * @param {string|null} remoteip  The submitter's IP, if known (optional but recommended).
 * @param {typeof fetch} [fetchImpl]  Injectable for tests; defaults to global fetch.
 * @returns {Promise<{ ok: boolean, skipped?: boolean, errorCodes?: string[] }>}
 *          ok:true, skipped:true when Turnstile is not configured.
 */
export async function verifyTurnstileToken(token, remoteip = null, fetchImpl = fetch) {
  if (!isTurnstileEnabled()) return { ok: true, skipped: true };

  const trimmed = String(token ?? "").trim();
  if (!trimmed) return { ok: false, errorCodes: ["missing-input-response"] };

  const form = new URLSearchParams();
  form.set("secret", String(process.env.TURNSTILE_SECRET_KEY).trim());
  form.set("response", trimmed);
  if (remoteip) form.set("remoteip", String(remoteip));

  try {
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = await response.json();
    return { ok: Boolean(data?.success), errorCodes: data?.["error-codes"] ?? [] };
  } catch (error) {
    // A Cloudflare outage must not wedge the form shut. Treat an unreachable
    // verifier as a soft pass: the honeypot, timing and content checks still
    // apply, and the alternative is blocking every genuine sender too.
    console.error("[turnstile] Verification request failed:", error.message);
    return { ok: true, skipped: true, errorCodes: ["verify-unreachable"] };
  }
}
