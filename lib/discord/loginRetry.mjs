/**
 * lib/discord/loginRetry.mjs
 *
 * Backoff and give-up rules for the Discord bot's login retry
 * (controllers/discordController.js). Imports nothing, so it is unit-testable.
 */

export const LOGIN_RETRY_MAX_MS = 5 * 60_000;

/** 5s, 10s, 20s ... capped at 5 minutes. `attempt` is the attempt that just failed (1-based). */
export function nextLoginDelayMs(attempt) {
  return Math.min(5_000 * 2 ** Math.max(0, (Number(attempt) || 1) - 1), LOGIN_RETRY_MAX_MS);
}

/** A bad token or disallowed intents won't fix itself; retrying would only spam. */
export function isFatalLoginError(error) {
  const code = error?.code;
  return (
    code === "TokenInvalid" ||
    code === "TokenMissing" ||
    code === "DisallowedIntents" ||
    Number(code) === 4004 || // authentication failed
    Number(code) === 4014 // disallowed intents
  );
}
