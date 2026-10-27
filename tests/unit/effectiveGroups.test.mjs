import { describe, expect, it } from "vitest";
import {
  expandGroups,
  getEffectiveGroups,
  isStaff,
} from "../../lib/permissions/effectiveGroups.mjs";

describe("expandGroups (pure inheritance walk)", () => {
  const parents = (map) => async (slugs) => {
    const out = [];
    for (const slug of slugs) for (const p of map[slug] || []) out.push(p);
    return out;
  };

  it("returns the direct groups when nothing is inherited", async () => {
    expect(await expandGroups(["moderator"], parents({}))).toEqual(["moderator"]);
  });

  it("resolves inheritance transitively", async () => {
    const result = await expandGroups(
      ["moderator"],
      parents({ moderator: ["staff"], staff: ["default"] })
    );
    expect(new Set(result)).toEqual(new Set(["moderator", "staff", "default"]));
  });

  it("de-duplicates diamond inheritance", async () => {
    const result = await expandGroups(
      ["srmod", "events"],
      parents({ srmod: ["staff"], events: ["staff"], staff: ["default"] })
    );
    expect(result.filter((g) => g === "staff")).toHaveLength(1);
    expect(new Set(result)).toEqual(new Set(["srmod", "events", "staff", "default"]));
  });

  it("terminates on an inheritance cycle", async () => {
    const result = await expandGroups(["a"], parents({ a: ["b"], b: ["a"] }));
    expect(new Set(result)).toEqual(new Set(["a", "b"]));
  });

  it("normalises slugs (trim + lowercase) and ignores blanks", async () => {
    const result = await expandGroups([" Moderator ", "", null], parents({ moderator: ["Staff"] }));
    expect(result).toEqual(["moderator", "staff"]);
  });
});

describe("getEffectiveGroups (assembly with injected query)", () => {
  // Fake LuckPerms query that branches on the SQL text, mirroring the three
  // query shapes the resolver issues.
  const fakeQuery =
    ({ direct = [], primary = [], parentMap = {} }) =>
    async (sql, params) => {
      if (sql.includes("primary_group")) return primary.map((slug) => ({ slug }));
      if (sql.includes("FROM luckperms_user_permissions"))
        return direct.map((slug) => ({ slug }));
      if (sql.includes("FROM luckperms_group_permissions")) {
        const out = [];
        for (const g of params) for (const p of parentMap[g] || []) out.push({ parent: p });
        return out;
      }
      return [];
    };

  it("returns direct groups plus inherited parents, sorted and de-duped", async () => {
    const groups = await getEffectiveGroups(
      { uuid: "U" },
      {
        query: fakeQuery({
          direct: ["moderator"],
          parentMap: { moderator: ["staff"], staff: ["default"] },
        }),
      }
    );
    expect(groups).toEqual(["default", "moderator", "staff"]);
  });

  it("falls back to primary_group when the user holds no explicit group", async () => {
    const groups = await getEffectiveGroups(
      { uuid: "U" },
      { query: fakeQuery({ direct: [], primary: ["guest"], parentMap: {} }) }
    );
    expect(groups).toEqual(["guest"]);
  });

  it("returns [] when there is no resolvable UUID", async () => {
    const groups = await getEffectiveGroups(
      {},
      { query: fakeQuery({}), mainQuery: async () => [] }
    );
    expect(groups).toEqual([]);
  });

  it("resolves a UUID from userId via the main DB when not supplied", async () => {
    const groups = await getEffectiveGroups(
      { userId: 42 },
      {
        mainQuery: async () => [{ uuid: "resolved-uuid" }],
        query: fakeQuery({ direct: ["admin"], parentMap: {} }),
      }
    );
    expect(groups).toEqual(["admin"]);
  });
});

describe("isStaff", () => {
  const staff = ["moderator", "admin", "srstaff"];

  it("is true when any effective group is a staff group", () => {
    expect(isStaff(["default", "moderator"], staff)).toBe(true);
  });

  it("is false when no effective group is a staff group", () => {
    expect(isStaff(["default", "member"], staff)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isStaff(["ADMIN"], staff)).toBe(true);
  });

  it("is false for empty / invalid input", () => {
    expect(isStaff([], staff)).toBe(false);
    expect(isStaff(undefined, staff)).toBe(false);
    expect(isStaff(["admin"], undefined)).toBe(false);
  });
});
