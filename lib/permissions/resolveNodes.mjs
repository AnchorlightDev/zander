/**
 * lib/permissions/resolveNodes.mjs
 *
 * Turns LuckPerms permission rows (grants AND negations) into the flat list of
 * granted node strings the web session stores. Pure, no imports.
 *
 * Rules, following LuckPerms:
 *   - a node set on the user beats the same node inherited from a group;
 *   - at the same level, a negation beats a grant of the same node;
 *   - an exact node beats any wildcard, and a longer wildcard beats a shorter
 *     one (`zander.web.settings=false` wins over `zander.web.*=true`).
 *
 * Every permission matcher in the app (api/common.js hasSpecificPermission and
 * its copies) only understands positive nodes and wildcards. So a granted
 * wildcard that has a negation somewhere underneath it is replaced by the
 * registry's concrete nodes it still grants. Nodes that are not in the
 * registry (e.g. dynamic `zander.web.tickets.<slug>`) are then only granted if
 * they are held explicitly.
 */

function normalise(node) {
  return typeof node === "string" ? node.trim().toLowerCase() : "";
}

function isWildcard(node) {
  return node === "*" || node.endsWith(".*");
}

/** Does pattern `w` (a wildcard or exact node) cover node `x`? */
export function covers(w, x) {
  if (w === "*") return true;
  if (w === x) return true;
  if (w.endsWith(".*")) {
    const base = w.slice(0, -2);
    return x === base || x.startsWith(base + ".");
  }
  return false;
}

function isGranted(value) {
  return value === true || Number(value) === 1;
}

/**
 * @param {{ userNodes?: {permission: string, value: any}[],
 *           groupNodes?: {permission: string, value: any}[],
 *           knownNodes?: string[] }} input
 * @returns {string[]} granted nodes
 */
export function resolveEffectiveNodes({ userNodes = [], groupNodes = [], knownNodes = [] } = {}) {
  const decided = new Map(); // normalised node -> boolean
  const spelling = new Map(); // normalised node -> first spelling seen

  const applyLevel = (rows) => {
    const level = new Map();
    for (const row of rows) {
      const node = normalise(row?.permission);
      if (!node || decided.has(node)) continue;
      if (!spelling.has(node)) spelling.set(node, row.permission.trim());
      const granted = isGranted(row.value);
      // Negation wins over a grant of the same node at the same level.
      level.set(node, level.has(node) ? level.get(node) && granted : granted);
    }
    for (const [node, granted] of level) decided.set(node, granted);
  };

  applyLevel(userNodes);
  applyLevel(groupNodes);

  // Only negations that touch website nodes matter here. Without this, an
  // owner's `*` would be expanded (losing dynamic nodes such as
  // zander.web.tickets.<slug>) just because the rank also negates some
  // unrelated game node like `essentials.fly`.
  const knownNorm = knownNodes.map(normalise).filter(Boolean);
  const negated = [...decided]
    .filter(([, granted]) => !granted)
    .map(([node]) => node)
    .filter((n) => n.startsWith("zander.") || n === "zander" || knownNorm.some((k) => covers(n, k)));

  const decide = (node) => {
    if (decided.has(node)) return decided.get(node);
    let best = null;
    for (const [pattern, granted] of decided) {
      if (!isWildcard(pattern) || !covers(pattern, node)) continue;
      if (!best || pattern.length > best.pattern.length) best = { pattern, granted };
    }
    return best ? best.granted : false;
  };

  const result = new Set();
  for (const [node, granted] of decided) {
    if (!granted) continue;
    const shadowed = isWildcard(node) && negated.some((n) => n !== node && covers(node, n));
    if (!shadowed) {
      result.add(spelling.get(node) ?? node);
      continue;
    }
    for (const known of knownNodes) {
      const k = normalise(known);
      if (!k || isWildcard(k) || k.includes("{")) continue;
      if (covers(node, k) && decide(k)) result.add(String(known).trim());
    }
  }

  return Array.from(result);
}
