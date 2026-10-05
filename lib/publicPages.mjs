/**
 * lib/publicPages.mjs
 *
 * Validation for the public contact form (routes/pagesRoutes.js). No DB or
 * network imports, so it is unit-testable. Resource rules are in
 * lib/resources.mjs.
 */

/** Length caps for the contact form. The message fits one Discord embed field (1024). */
export const CONTACT_LIMITS = { name: 100, email: 254, message: 1000 };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a contact form submission.
 *
 * @returns {{ ok: true, value: { name, email, message } } | { ok: false, error: string }}
 */
export function parseContactSubmission(body) {
  const name = String(body?.name ?? "").trim();
  const email = String(body?.email ?? "").trim();
  const message = String(body?.message ?? "").trim();

  if (!name || !email || !message) return { ok: false, error: "Please fill in your name, email and message." };
  if (name.length > CONTACT_LIMITS.name) return { ok: false, error: `Name must be ${CONTACT_LIMITS.name} characters or fewer.` };
  if (email.length > CONTACT_LIMITS.email || !EMAIL.test(email)) return { ok: false, error: "Please enter a valid email address." };
  if (message.length > CONTACT_LIMITS.message) return { ok: false, error: `Message must be ${CONTACT_LIMITS.message} characters or fewer.` };

  return { ok: true, value: { name, email, message } };
}
