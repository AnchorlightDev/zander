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
  }
  if (!subject || !message) return { ok: false, error: "Please add a subject and your message." };
  if (subject.length > CONTACT_LIMITS.subject) return { ok: false, error: `Subject must be ${CONTACT_LIMITS.subject} characters or fewer.` };
  if (message.length > CONTACT_LIMITS.message) return { ok: false, error: `Message must be ${CONTACT_LIMITS.message} characters or fewer.` };

  return { ok: true, value: { name: signedIn ? "" : name, email: signedIn ? "" : email.toLowerCase(), subject, message } };
}

/** Validate a guest's reply on their private ticket page. */
export function parseGuestReply(body) {
  const message = String(body?.message ?? "").trim();
  if (!message) return { ok: false, error: "Please write a message." };
  if (message.length > CONTACT_LIMITS.message) return { ok: false, error: `Message must be ${CONTACT_LIMITS.message} characters or fewer.` };
  return { ok: true, value: message };
}
