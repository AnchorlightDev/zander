// Decoding for QuickShop-Hikari's new item format (~2026-04-22, qs_data.id ≥ 6000):
// qs_data.item holds base64( gzip( NBT ) ). Two item layouts are handled:
//   modern (1.20.5+): { id, count, components: { "minecraft:stored_enchantments": ... } }
//   legacy (≤1.20.4): { id, Count, tag: { StoredEnchantments: [{ id, lvl }], ... } }
// and the item compound may be nested under a wrapper rather than at the root.
// No DB imports here so the parsing is unit-testable.

import zlib from "zlib";

// Bump when the shape written to qs_data.name changes, so the index cron
// re-processes rows indexed by an older version.
export const SHOP_INDEX_VERSION = 3;

const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12,
};

// Minimal big-endian NBT reader (Java edition). Returns plain JS values:
// compounds → objects, lists/arrays → arrays, longs → BigInt.
export function parseNbt(buf) {
  let pos = 0;
  const readString = () => {
    const len = buf.readUInt16BE(pos);
    pos += 2;
    const s = buf.toString("utf8", pos, pos + len);
    pos += len;
    return s;
  };

  const readPayload = (type, depth) => {
    if (depth > 64) throw new Error("NBT nesting too deep");
    switch (type) {
      case TAG.BYTE: { const v = buf.readInt8(pos); pos += 1; return v; }
      case TAG.SHORT: { const v = buf.readInt16BE(pos); pos += 2; return v; }
      case TAG.INT: { const v = buf.readInt32BE(pos); pos += 4; return v; }
      case TAG.LONG: { const v = buf.readBigInt64BE(pos); pos += 8; return v; }
      case TAG.FLOAT: { const v = buf.readFloatBE(pos); pos += 4; return v; }
      case TAG.DOUBLE: { const v = buf.readDoubleBE(pos); pos += 8; return v; }
      case TAG.STRING: return readString();
      case TAG.BYTE_ARRAY:
      case TAG.INT_ARRAY:
      case TAG.LONG_ARRAY: {
        const n = buf.readInt32BE(pos);
        pos += 4;
        const el = type === TAG.BYTE_ARRAY ? TAG.BYTE : type === TAG.INT_ARRAY ? TAG.INT : TAG.LONG;
        const out = [];
        for (let i = 0; i < n; i++) out.push(readPayload(el, depth + 1));
        return out;
      }
      case TAG.LIST: {
        const el = buf.readUInt8(pos);
        pos += 1;
        const n = buf.readInt32BE(pos);
        pos += 4;
        const out = [];
        for (let i = 0; i < n; i++) out.push(readPayload(el, depth + 1));
        return out;
      }
      case TAG.COMPOUND: {
        const obj = {};
        for (;;) {
          const t = buf.readUInt8(pos);
          pos += 1;
          if (t === TAG.END) return obj;
          const key = readString();
          obj[key] = readPayload(t, depth + 1);
        }
      }
      default:
        throw new Error(`Unknown NBT tag type ${type}`);
    }
  };

  const rootType = buf.readUInt8(pos);
  pos += 1;
  if (rootType !== TAG.COMPOUND) throw new Error("NBT root is not a compound");
  readString(); // root name (usually empty)
  return readPayload(TAG.COMPOUND, 0);
}

const stripNs = (id) => String(id || "").replace(/^minecraft:/, "");

// Enchantment components are either { levels: { id: lvl }, show_in_tooltip }
// (1.20.5–1.21.4) or a bare { id: lvl } map (1.21.5+).
function readEnchantments(component) {
  if (!component || typeof component !== "object") return null;
  const levels = component.levels && typeof component.levels === "object" ? component.levels : component;
  const out = {};
  for (const [key, lvl] of Object.entries(levels)) {
    if (key === "show_in_tooltip" || typeof lvl !== "number") continue;
    out[stripNs(key)] = lvl;
  }
  return Object.keys(out).length ? out : null;
}

// potion_contents is a bare string when only the base potion is set,
// otherwise a compound with an optional `potion` field.
function readPotion(component) {
  if (!component) return null;
  if (typeof component === "string") return stripNs(component);
  if (typeof component.potion === "string") return stripNs(component.potion);
  return null;
}

// Legacy enchantment lists: [{ id: "minecraft:sharpness", lvl: 5s }]
function readLegacyEnchantments(list) {
  if (!Array.isArray(list)) return null;
  const out = {};
  for (const entry of list) {
    if (typeof entry?.id !== "string") continue;
    out[stripNs(entry.id)] = Number(entry.lvl) || 1;
  }
  return Object.keys(out).length ? out : null;
}

// Modern: [{ item: { id, count }, slot }]. Legacy: [{ id, Count, Slot }].
function readContainer(list) {
  if (!Array.isArray(list)) return null;
  const items = {};
  for (const slot of list) {
    const item = slot?.item || slot;
    if (typeof item?.id !== "string") continue;
    const id = stripNs(item.id);
    items[id] = (items[id] || 0) + (Number(item.count ?? item.Count) || 1);
  }
  return Object.keys(items).length ? items : null;
}

// The item compound is normally the root, but tolerate a wrapper
// (e.g. { item: { id, ... } }) by taking the shallowest compound with a string id.
function findItemCompound(root) {
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    if (typeof node.id === "string") return node;
    for (const value of Object.values(node)) {
      if (value && typeof value === "object" && !Array.isArray(value)) queue.push(value);
    }
  }
  return null;
}

/**
 * Decode a qs_data.item value in the new format into the metadata we index.
 * Returns null if the value can't be decoded.
 *   { id, count, ench?, potion?, flight?, contents? }
 */
export function decodeShopItem(rawItem) {
  try {
    const root = findItemCompound(parseNbt(zlib.gunzipSync(Buffer.from(rawItem, "base64"))));
    if (!root) return null;

    const components = root.components || {};
    const tag = root.tag || {};
    const meta = { id: stripNs(root.id), count: Number(root.count ?? root.Count) || 1 };

    const ench = readEnchantments(components["minecraft:stored_enchantments"])
      || readEnchantments(components["minecraft:enchantments"])
      || readLegacyEnchantments(tag.StoredEnchantments)
      || readLegacyEnchantments(tag.Enchantments);
    if (ench) meta.ench = ench;

    const potion = readPotion(components["minecraft:potion_contents"])
      || (typeof tag.Potion === "string" ? stripNs(tag.Potion) : null);
    if (potion) meta.potion = potion;

    const flight = components["minecraft:fireworks"]?.flight_duration ?? tag.Fireworks?.Flight;
    if (typeof flight === "number") meta.flight = flight;

    const contents = readContainer(components["minecraft:container"])
      || readContainer(tag.BlockEntityTag?.Items);
    if (contents) meta.contents = contents;

    return meta;
  } catch {
    return null;
  }
}

/**
 * Build the JSON stored in qs_data.name. `tags` is a flat, space-separated
 * string of searchable keys (enchantment and potion IDs) so the shop search
 * can match "sharpness" or "fire protection" with a single LIKE.
 */
export function buildIndexValue(meta) {
  if (!meta) return JSON.stringify({ v: SHOP_INDEX_VERSION });
  const tags = [...Object.keys(meta.ench || {}), meta.potion].filter(Boolean).join(" ");
  return JSON.stringify({ v: SHOP_INDEX_VERSION, ...meta, tags });
}

const titleCase = (id) => stripNs(id).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const levelLabel = (lvl) => ROMAN[lvl] || String(lvl);

/** "Sharpness V, Unbreaking III" */
export function formatEnchantments(ench) {
  if (!ench) return null;
  const parts = Object.entries(ench).map(([id, lvl]) => `${titleCase(id)} ${levelLabel(lvl)}`);
  return parts.length ? parts.join(", ") : null;
}

/** "Sand x1728, Gravel x64 +2 more" — matches the old-format shulker summary. */
export function formatContents(contents) {
  if (!contents) return null;
  const entries = Object.entries(contents).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, 3)
    .map(([id, n]) => (n > 1 ? `${titleCase(id)} x${n}` : titleCase(id)))
    .join(", ");
  return entries.length > 3 ? `${shown} +${entries.length - 3} more` : shown;
}

export { titleCase as formatItemId };
