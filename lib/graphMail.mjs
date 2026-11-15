/**
 * Microsoft Graph mail transport.
 *
 * Sends through POST /users/{sender}/sendMail using an Entra app registration
 * (client credentials, Mail.Send application permission). This works for
 * shared mailboxes with no licence and sign-in blocked, and does not depend on
 * SMTP AUTH, which Microsoft is retiring.
 *
 * No DB or env imports here so it stays unit-testable: pass config and,
 * optionally, a fetch implementation.
 */

const TOKEN_SKEW_MS = 60_000;

/** Parse `"Display Name" <addr@x>` or `addr@x` into a Graph emailAddress. */
export function parseAddress(value) {
  if (!value) return null;
  if (typeof value === "object" && value.address) {
    return { address: value.address, ...(value.name ? { name: value.name } : {}) };
  }
  const str = String(value).trim();
  const match = str.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].trim();
    return { address: match[2].trim(), ...(name ? { name } : {}) };
  }
  return { address: str };
}

function toRecipients(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list
    .map((v) => (typeof v === "string" ? v.trim() : v))
    .filter(Boolean)
    .map((v) => ({ emailAddress: parseAddress(v) }));
}

/** Convert nodemailer-style mail options into a Graph sendMail payload. */
export function buildGraphMessage(mailOptions) {
  const { subject, html, text, to, cc, bcc, replyTo, from } = mailOptions;
  const message = {
    subject: subject ?? "",
    body: html != null
      ? { contentType: "HTML", content: String(html) }
      : { contentType: "Text", content: String(text ?? "") },
    toRecipients: toRecipients(to),
  };
  const ccList = toRecipients(cc);
  const bccList = toRecipients(bcc);
  const replyList = toRecipients(replyTo);
  if (ccList.length) message.ccRecipients = ccList;
  if (bccList.length) message.bccRecipients = bccList;
  if (replyList.length) message.replyTo = replyList;
  const fromAddr = parseAddress(from);
  if (fromAddr) message.from = { emailAddress: fromAddr };
  return { message, saveToSentItems: false };
}

export function createGraphTransport({ tenantId, clientId, clientSecret, sender, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const missing = Object.entries({ tenantId, clientId, clientSecret, sender })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`[EMAIL] Graph transport missing config: ${missing.join(", ")}`);
  }

  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - TOKEN_SKEW_MS) return cachedToken;
    const res = await doFetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }).toString(),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const err = new Error(
        `Graph token request failed (${res.status}): ${data.error_description || data.error || "unknown error"}`
      );
      err.response = JSON.stringify(data);
      throw err;
    }
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return cachedToken;
  }

  async function sendMail(mailOptions) {
    const token = await getToken();
    const payload = buildGraphMessage(mailOptions);
    const res = await doFetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    if (res.status === 401) cachedToken = null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let detail = body;
      try {
        const parsed = JSON.parse(body);
        detail = parsed?.error?.message || body;
      } catch {}
      const err = new Error(`Graph sendMail failed (${res.status}): ${detail}`);
      err.response = body;
      throw err;
    }
    const accepted = payload.message.toRecipients.map((r) => r.emailAddress.address);
    return {
      messageId: res.headers?.get?.("request-id") || undefined,
      accepted,
      rejected: [],
    };
  }

  return { sendMail, describe: () => `Microsoft Graph as ${sender}` };
}
