import { describe, it, expect } from "vitest";
import zlib from "zlib";
import {
  parseNbt,
  decodeShopItem,
  buildIndexValue,
  formatEnchantments,
  formatContents,
  SHOP_INDEX_VERSION,
} from "../../lib/quickshopNbt.js";

// Tiny NBT writer for fixtures. Values are tagged explicitly: [type, value].
const T = { BYTE: 1, SHORT: 2, INT: 3, STRING: 8, LIST: 9, COMPOUND: 10 };
const str = (s) => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};
function payload([type, value]) {
  switch (type) {
    case T.BYTE: return Buffer.from([value & 0xff]);
    case T.SHORT: { const b = Buffer.alloc(2); b.writeInt16BE(value); return b; }
    case T.INT: { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; }
    case T.STRING: return str(value);
    case T.LIST: {
      const [elType, items] = value;
      const head = Buffer.alloc(5);
      head.writeUInt8(elType, 0);
      head.writeInt32BE(items.length, 1);
      return Buffer.concat([head, ...items.map((v) => payload([elType, v]))]);
    }
    case T.COMPOUND: {
      const parts = Object.entries(value).map(([k, tagged]) =>
        Buffer.concat([Buffer.from([tagged[0]]), str(k), payload(tagged)])
      );
      return Buffer.concat([...parts, Buffer.from([0])]);
    }
  }
  throw new Error("fixture type");
}
const compound = (obj) => [T.COMPOUND, obj];
const encodeItem = (root) =>
  zlib.gzipSync(Buffer.concat([Buffer.from([T.COMPOUND]), str(""), payload(compound(root))])).toString("base64");

const item = (id, components = {}, count = 1) => ({
  DataVersion: [T.INT, 4189],
  id: [T.STRING, `minecraft:${id}`],
  count: [T.INT, count],
  ...(Object.keys(components).length ? { components: compound(components) } : {}),
});

describe("parseNbt", () => {
  it("reads a nested compound", () => {
    const buf = Buffer.concat([Buffer.from([T.COMPOUND]), str(""), payload(compound({ a: [T.INT, 7], b: compound({ c: [T.STRING, "x"] }) }))]);
    expect(parseNbt(buf)).toEqual({ a: 7, b: { c: "x" } });
  });
});

describe("decodeShopItem", () => {
  it("decodes a plain item", () => {
    expect(decodeShopItem(encodeItem(item("diamond", {}, 64)))).toEqual({ id: "diamond", count: 64 });
  });

  it("reads stored enchantments in the 1.21.4 { levels } shape", () => {
    const raw = encodeItem(item("enchanted_book", {
      "minecraft:stored_enchantments": compound({
        levels: compound({ "minecraft:sharpness": [T.INT, 5] }),
      }),
    }));
    expect(decodeShopItem(raw)).toMatchObject({ id: "enchanted_book", ench: { sharpness: 5 } });
  });

  it("reads stored enchantments in the 1.21.5+ bare-map shape", () => {
    const raw = encodeItem(item("enchanted_book", {
      "minecraft:stored_enchantments": compound({
        "minecraft:fire_protection": [T.INT, 4],
        "minecraft:unbreaking": [T.INT, 3],
      }),
    }));
    expect(decodeShopItem(raw).ench).toEqual({ fire_protection: 4, unbreaking: 3 });
  });

  it("reads enchantments on gear", () => {
    const raw = encodeItem(item("diamond_sword", {
      "minecraft:enchantments": compound({ "minecraft:looting": [T.INT, 3] }),
    }));
    expect(decodeShopItem(raw).ench).toEqual({ looting: 3 });
  });

  it("reads potions as a bare string or compound", () => {
    const bare = encodeItem(item("potion", { "minecraft:potion_contents": [T.STRING, "minecraft:strong_healing"] }));
    const obj = encodeItem(item("splash_potion", {
      "minecraft:potion_contents": compound({ potion: [T.STRING, "minecraft:long_night_vision"] }),
    }));
    expect(decodeShopItem(bare).potion).toBe("strong_healing");
    expect(decodeShopItem(obj).potion).toBe("long_night_vision");
  });

  it("reads firework flight duration and shulker contents", () => {
    const rocket = encodeItem(item("firework_rocket", {
      "minecraft:fireworks": compound({ flight_duration: [T.BYTE, 3] }),
    }));
    expect(decodeShopItem(rocket).flight).toBe(3);

    const slot = (id, count, s) => ({
      item: compound({ id: [T.STRING, `minecraft:${id}`], count: [T.INT, count] }),
      slot: [T.INT, s],
    });
    const shulker = encodeItem(item("shulker_box", {
      "minecraft:container": [T.LIST, [T.COMPOUND, [slot("sand", 64, 0), slot("sand", 64, 1), slot("gravel", 10, 2)]]],
    }));
    expect(decodeShopItem(shulker).contents).toEqual({ sand: 128, gravel: 10 });
  });

  it("reads legacy (pre-1.20.5) tag.StoredEnchantments / tag.Enchantments", () => {
    const ench = (id, lvl) => ({ id: [T.STRING, `minecraft:${id}`], lvl: [T.SHORT, lvl] });
    const book = encodeItem({
      id: [T.STRING, "minecraft:enchanted_book"],
      Count: [T.BYTE, 1],
      tag: compound({ StoredEnchantments: [T.LIST, [T.COMPOUND, [ench("sharpness", 5)]]] }),
    });
    expect(decodeShopItem(book)).toMatchObject({ id: "enchanted_book", count: 1, ench: { sharpness: 5 } });

    const sword = encodeItem({
      id: [T.STRING, "minecraft:netherite_sword"],
      Count: [T.BYTE, 1],
      tag: compound({ Enchantments: [T.LIST, [T.COMPOUND, [ench("sharpness", 5), ench("looting", 3)]]] }),
    });
    expect(decodeShopItem(sword).ench).toEqual({ sharpness: 5, looting: 3 });
  });

  it("reads legacy potion, firework and shulker data", () => {
    const potion = encodeItem({ id: [T.STRING, "minecraft:potion"], Count: [T.BYTE, 1], tag: compound({ Potion: [T.STRING, "minecraft:swiftness"] }) });
    expect(decodeShopItem(potion).potion).toBe("swiftness");

    const rocket = encodeItem({ id: [T.STRING, "minecraft:firework_rocket"], Count: [T.BYTE, 64], tag: compound({ Fireworks: compound({ Flight: [T.BYTE, 2] }) }) });
    expect(decodeShopItem(rocket)).toMatchObject({ count: 64, flight: 2 });

    const entry = (id, n) => ({ id: [T.STRING, `minecraft:${id}`], Count: [T.BYTE, n], Slot: [T.BYTE, 0] });
    const shulker = encodeItem({
      id: [T.STRING, "minecraft:shulker_box"],
      Count: [T.BYTE, 1],
      tag: compound({ BlockEntityTag: compound({ Items: [T.LIST, [T.COMPOUND, [entry("sand", 64), entry("sand", 64)]]] }) }),
    });
    expect(decodeShopItem(shulker).contents).toEqual({ sand: 128 });
  });

  it("finds the item inside a wrapper compound", () => {
    const raw = encodeItem({ DataVersion: [T.INT, 4189], item: compound(item("enchanted_book", {
      "minecraft:stored_enchantments": compound({ "minecraft:mending": [T.INT, 1] }),
    })) });
    expect(decodeShopItem(raw)).toMatchObject({ id: "enchanted_book", ench: { mending: 1 } });
  });

  it("returns null for garbage", () => {
    expect(decodeShopItem("not base64 gzip")).toBeNull();
  });
});

describe("buildIndexValue", () => {
  it("stamps the version and builds searchable tags", () => {
    const value = JSON.parse(buildIndexValue({ id: "enchanted_book", count: 1, ench: { sharpness: 5, unbreaking: 3 } }));
    expect(value.v).toBe(SHOP_INDEX_VERSION);
    expect(value.id).toBe("enchanted_book");
    expect(value.tags).toBe("sharpness unbreaking");
  });

  it("stamps the version on decode failure so the row isn't retried", () => {
    expect(JSON.parse(buildIndexValue(null))).toEqual({ v: SHOP_INDEX_VERSION });
  });
});

describe("formatting", () => {
  it("formats enchantments with roman levels", () => {
    expect(formatEnchantments({ sharpness: 5, fire_protection: 4 })).toBe("Sharpness V, Fire Protection IV");
  });

  it("summarises container contents", () => {
    expect(formatContents({ sand: 1728, gravel: 64, dirt: 1, stone: 2 })).toBe("Sand x1728, Gravel x64, Stone x2 +1 more");
  });
});
