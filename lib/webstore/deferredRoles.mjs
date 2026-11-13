/**
 * Decide what to do with deferred discord_role command runs when the recipient
 * finally links Discord. No DB import, so it is unit-testable.
 *
 * Only the latest run per (purchase, role) matters: a grant followed by a
 * revoke must end with the role removed, whatever order the rows come back in.
 * A grant is also dropped when the purchase it belongs to no longer entitles
 * the recipient (refunded, or a subscription that has ended or been revoked).
 *
 * Each run needs: commandRunId, purchaseId, action, commandTemplate, and
 * optionally purchaseStatus, purchaseType and subscriptionStatus.
 *
 * @returns {Array<{run: object, decision: 'add'|'remove'|'superseded'|'inactive'}>}
 *          in commandRunId order
 */
export function planDeferredRoleRuns(runs) {
  const sorted = [...(runs || [])].sort((a, b) => Number(a.commandRunId) - Number(b.commandRunId));
  const keyOf = (run) => `${run.purchaseId}|${String(run.commandTemplate || "").trim()}`;

  const latest = new Map();
  for (const run of sorted) latest.set(keyOf(run), run);

  return sorted.map((run) => {
    if (latest.get(keyOf(run)) !== run) return { run, decision: "superseded" };
    if (run.action === "revoke") return { run, decision: "remove" };
    return { run, decision: grantStillEntitled(run) ? "add" : "inactive" };
  });
}

function grantStillEntitled(run) {
  if (run.purchaseStatus === "refunded") return false;
  if (run.purchaseType === "subscription" && run.subscriptionStatus) {
    return run.subscriptionStatus === "active" || run.subscriptionStatus === "past_due";
  }
  return true;
}
