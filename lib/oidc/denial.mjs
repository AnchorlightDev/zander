/**
 * lib/oidc/denial.mjs
 *
 * Turns a refused staff sign-in (resolveStaffStatus → { ok: false, ... }) into
 * plain-language reasons for the "Staff only" page, so the person — or the
 * admin they send a screenshot to — can see exactly what to fix.
 *
 * Pure, so it can be unit-tested. Rank slugs are shown, never the full list of
 * allowed ranks.
 */

function contextLabel(issue) {
  const parts = [];
  if (issue.server && issue.server !== "global") parts.push(`server "${issue.server}"`);
  if (issue.world && issue.world !== "global") parts.push(`world "${issue.world}"`);
  return parts.join(" and ") || "a specific context";
}

function dateLabel(seconds) {
  const d = new Date(Number(seconds) * 1000);
  return Number.isNaN(d.getTime()) ? "an earlier date" : d.toISOString().slice(0, 10);
}

/**
 * @param {{ reason: string, user?: {username?: string}, groups?: string[], issues?: object[] }} status
 * @param {{ product?: string }} [opts]
 * @returns {{ summary: string, reasons: string[], footer: string }}
 */
export function explainDenial(status = {}, { product = "Compass" } = {}) {
  const username = status.user?.username || null;
  const reasons = [];
  let summary = `${product} is for CFC staff only. Your account doesn't currently hold a staff rank that can sign in.`;

  if (status.reason === "no_account") {
    summary = `${product} is for CFC staff only, and we couldn't find a CFC account for this sign-in.`;
    reasons.push("Your Zander session doesn't match an existing account. Sign out of Zander, sign back in, and try again.");
  } else if (status.reason === "account_disabled") {
    summary = `${product} is for CFC staff only, and your CFC account is disabled.`;
    reasons.push("Your account has been disabled in Zander. An admin needs to re-enable it.");
  } else {
    for (const issue of status.issues || []) {
      if (issue.problem === "context") {
        reasons.push(
          `You have the "${issue.group}" rank, but only on ${contextLabel(issue)}. ` +
            `To sign in it has to be granted network-wide (global), e.g. /lp user ${username || "<name>"} parent add ${issue.group}`
        );
      } else if (issue.problem === "expired") {
        reasons.push(`Your "${issue.group}" rank was temporary and expired on ${dateLabel(issue.expiredAt)}.`);
      } else if (issue.problem === "negated") {
        reasons.push(`Your "${issue.group}" rank is set to false on your account, so it doesn't count.`);
      }
    }
    if (!reasons.length) {
      const groups = (status.groups || []).filter((g) => g !== "default");
      reasons.push(
        groups.length
          ? `Ranks found on your account: ${groups.join(", ")}. None of them are allowed to sign in to ${product}.`
          : "No ranks were found on your account."
      );
    }
  }

  const who = username ? `Signed in to Zander as ${username}. ` : "";
  return {
    summary,
    reasons,
    footer: `${who}If you think this is wrong, send a screenshot of this page to an admin.`,
  };
}
