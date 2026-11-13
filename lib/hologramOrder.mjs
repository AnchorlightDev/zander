/**
 * Move `id` one place up (earlier) or down (later) in an ordered list of ids.
 * Returns the new order, or null when the id is missing or already at that end.
 * Callers write each id's index back as its sortOrder, so frames that all
 * share the default sortOrder 0 still reorder.
 *
 * @param {number[]} orderedIds Ids in their current display order.
 * @param {number} id
 * @param {"up"|"down"} direction
 * @returns {number[] | null}
 */
export function moveIdInOrder(orderedIds, id, direction) {
  const index = orderedIds.indexOf(id);
  if (index === -1) return null;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= orderedIds.length) return null;
  const next = orderedIds.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
