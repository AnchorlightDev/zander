/**
 * lib/publicPages.mjs
 *
 * Validation for the public contact form (routes/pagesRoutes.js), which opens
 * a support ticket (services/contactTicketService.js). No DB or network
 * imports, so it is unit-testable.
 */

/** Length caps for the contact form. The message fits one Discord embed description. */
export const CONTACT_LIMITS = { name: 100, email: 254, subject: 120, message: 4000 };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** URLs (and bare domains) across subject + message. Most legitimate first
 * contacts carry none; spam carries several, so a handful is the ceiling. */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ru|cn|xyz|top|info|biz|online|site|shop|store|click|link)\b/gi;
export const MAX_CONTACT_LINKS = 3;

/** The lower-bound seconds a human needs to fill the form; faster is a bot. */
export const MIN_CONTACT_FILL_SECONDS = 3;

/**
 * Throwaway/disposable email providers. Nobody using one wants a reply, which is
 * the entire point of the contact form, so guest submissions from these are
 * refused. Kept short and lowercase; extend as new ones show up in the spam.
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com",
  "10minutemail.com", "tempmail.com", "temp-mail.org", "tempmail.net",
  "throwawaymail.com", "yopmail.com", "trashmail.com", "getnada.com",
  "maildrop.cc", "dispostable.com", "fakeinbox.com", "mailnesia.com",
  "mohmal.com", "emailondeck.com", "spam4.me", "mailcatch.com",
]);

/** How many link-like tokens appear in a blob of text. */
export function countLinks(text) {
  const matches = String(text ?? "").match(URL_PATTERN);
  return matches ? matches.length : 0;
}

/** True when an email's domain is a known disposable/throwaway provider. */
export function isDisposableEmail(email) {
  const domain = String(email ?? "").toLowerCase().trim().split("@")[1] || "";
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

/**
 * Bot timing check: was the form submitted implausibly fast after it rendered?
 *
 * `renderedAt` is the millisecond timestamp stamped into the form when it was
 * served. A missing or unparseable value is NOT treated as a bot (to avoid
 * false positives from cached pages or clock quirks) -- only a clearly-too-fast
 * submission is. Returns true when the submission looks automated.
 */
export function isSubmittedTooFast(renderedAt, now = Date.now()) {
  const stamped = Number(renderedAt);
  if (!Number.isFinite(stamped) || stamped <= 0) return false;
  const elapsedMs = now - stamped;
  // A future timestamp (negative elapsed) is tampering; treat as a bot.
  if (elapsedMs < 0) return true;
  return elapsedMs < MIN_CONTACT_FILL_SECONDS * 1000;
}

/**
 * Validate a contact form submission. Signed-in people are known already, so
 * only guests give a name and email.
 *
 * @returns {{ ok: true, value: { name, email, subject, message } } | { ok: false, error: string }}
 */
export function parseContactSubmission(body, { signedIn = false } = {}) {
  const name = String(body?.name ?? "").trim();
  const email = String(body?.email ?? "").trim();
  const subject = String(body?.subject ?? "").trim();
  const message = String(body?.message ?? "").trim();

  if (!signedIn) {
    if (!name || !email) return { ok: false, error: "Please fill in your name and email so we can reply." };
    if (name.length > CONTACT_LIMITS.name) return { ok: false, error: `Name must be ${CONTACT_LIMITS.name} characters or fewer.` };
    if (email.length > CONTACT_LIMITS.email || !EMAIL.test(email)) return { ok: false, error: "Please enter a valid email address." };
    // A reply is the whole point of the form; a throwaway inbox can't receive one.
    if (isDisposableEmail(email)) return { ok: false, error: "Please use an email address we can actually reply to." };
  }
  if (!subject || !message) return { ok: false, error: "Please add a subject and your message." };
  if (subject.length > CONTACT_LIMITS.subject) return { ok: false, error: `Subject must be ${CONTACT_LIMITS.subject} characters or fewer.` };
  if (message.length > CONTACT_LIMITS.message) return { ok: false, error: `Message must be ${CONTACT_LIMITS.message} characters or fewer.` };
  // Link flooding is the clearest tell of the SEO/"pricing" spam this form gets.
  if (countLinks(`${subject} ${message}`) > MAX_CONTACT_LINKS) {
    return { ok: false, error: "Your message contains too many links. Please remove some and try again." };
  }

  return { ok: true, value: { name: signedIn ? "" : name, email: signedIn ? "" : email.toLowerCase(), subject, message } };
}

/** Validate a guest's reply on their private ticket page. */
export function parseGuestReply(body) {
  const message = String(body?.message ?? "").trim();
  if (!message) return { ok: false, error: "Please write a message." };
  if (message.length > CONTACT_LIMITS.message) return { ok: false, error: `Message must be ${CONTACT_LIMITS.message} characters or fewer.` };
  return { ok: true, value: message };
}
