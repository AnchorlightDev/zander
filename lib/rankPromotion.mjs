/**
 * lib/rankPromotion.mjs
 *
 * The self-promotion rule for rank assignment: nobody may give themselves a
 * rank that outweighs the highest one they already hold. Kept free of DB
 * imports so it is unit-testable; api/routes/ranks.js supplies the weights.
 *
 * Weight is the LuckPerms `weight.N` node. A rank without one counts as 0,
 * which is also how the rank list sorts it.
 */

/** Whether actor and target are the same person, by userId or LuckPerms uuid. */
export function isSameUser(actor = {}, target = {}) {
  if (actor.userId != null && target.userId != null) {
    if (Number(actor.userId) === Number(target.userId)) return true;
  }
  const actorUuid = String(actor.uuid ?? "").trim().toLowerCase();
  const targetUuid = String(target.uuid ?? "").trim().toLowerCase();
  return Boolean(actorUuid) && actorUuid === targetUuid;
}

function weightOf(priority) {
  const n = Number(priority);
  return Number.isFinite(n) ? n : 0;
}

/**
 * True when assigning a rank of `rankWeight` would lift someone above the
 * highest of `heldWeights` (the ranks they hold now). Equal is allowed.
 */
export function isAboveHighestRank(rankWeight, heldWeights = []) {
  const highest = heldWeights.length ? Math.max(...heldWeights.map(weightOf)) : 0;
  return weightOf(rankWeight) > highest;
}
