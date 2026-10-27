/**
 * tests/unit/zanderNodes.test.mjs
 *
 * The permission registry behind the ranks dashboard checklist. The registry is
 * the source of truth; the public permissions page on the docs site is
 * generated from it with `node scripts/permissionsTable.mjs`.
 */

import { describe, expect, it } from "vitest";
import {
  PERMISSION_GROUPS,
  grantableGroups,
  isGrantableNode,
  listAllNodes,
  listGrantableNodes,
  partitionHeldNodes,
} from "../../lib/permissions/zanderNodes.mjs";
import { renderPermissionTables } from "../../scripts/permissionsTable.mjs";

describe("the registry is well-formed", () => {
  it("lists every node once", () => {
    const nodes = listAllNodes();
    const dupes = nodes.filter((node, i) => nodes.indexOf(node) !== i);
    expect(dupes, `listed more than once: ${dupes.join(", ")}`).toEqual([]);
  });

  it("only holds zander.* nodes, each with a description", () => {
    for (const group of PERMISSION_GROUPS) {
      expect(group.group, "group name").toBeTruthy();
      for (const entry of group.nodes) {
        expect(entry.node, entry.node).toMatch(/^zander\./);
        expect(entry.description, entry.node).toBeTruthy();
      }
    }
  });

  it("covers a meaningful number of nodes", () => {
    expect(listAllNodes().length).toBeGreaterThan(40);
  });
});

describe("the docs table generator", () => {
  it("renders one row per node under each group heading", () => {
    const md = renderPermissionTables();
    for (const group of PERMISSION_GROUPS) {
      expect(md).toContain(`## ${group.group}`);
    }
    const rows = [...md.matchAll(/^\|\s*`(zander\.[^`]+)`\s*\|/gm)].map((m) => m[1]);
    expect(rows).toEqual(listAllNodes());
  });
});

describe("what may be ticked", () => {
  it("never offers a wildcard", () => {
    // One click handing out everything under a prefix -- including nodes added
    // later that nobody reviewed -- is exactly what this must not allow.
    for (const node of listGrantableNodes()) {
      expect(node, node).not.toContain("*");
    }
    expect(isGrantableNode("zander.web.finance.*")).toBe(false);
    expect(isGrantableNode("zander.web.tickets.*")).toBe(false);
  });

  it("never offers the all-access node", () => {
    expect(isGrantableNode("*")).toBe(false);
    expect(listGrantableNodes()).not.toContain("*");
  });

  it("never offers a dynamic placeholder", () => {
    // `{slug}` is a pattern, not a node; setting it literally grants nothing.
    for (const node of listGrantableNodes()) {
      expect(node, node).not.toContain("{");
    }
    expect(isGrantableNode("zander.web.tickets.{slug}")).toBe(false);
  });

  it("rejects anything not in the list, however plausible", () => {
    expect(isGrantableNode("zander.web.doesnotexist")).toBe(false);
    expect(isGrantableNode("someotherplugin.admin")).toBe(false);
    expect(isGrantableNode("")).toBe(false);
    expect(isGrantableNode(null)).toBe(false);
  });

  it("accepts the real ones, trimming whitespace", () => {
    expect(isGrantableNode("zander.web.forms")).toBe(true);
    expect(isGrantableNode("  zander.web.forms  ")).toBe(true);
    expect(isGrantableNode("zander.forums.moderate")).toBe(true);
  });

  it("has no duplicates", () => {
    const all = listAllNodes();
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("grantableGroups", () => {
  it("drops the non-grantable entries but keeps their groups", () => {
    const finance = grantableGroups().find((g) => g.group === "Finance");

    expect(finance.nodes.map((n) => n.node)).toEqual([
      "zander.web.finance",
      "zander.web.finance.manage",
    ]);
  });

  it("gives every node a description to render", () => {
    for (const group of grantableGroups()) {
      for (const node of group.nodes) {
        expect(node.description, node.node).toBeTruthy();
      }
    }
  });

  it("keeps the documented grouping", () => {
    expect(grantableGroups().map((g) => g.group)).toEqual(
      PERMISSION_GROUPS.map((g) => g.group)
    );
  });
});

describe("partitionHeldNodes", () => {
  it("separates what this screen manages from what it must not touch", () => {
    // A LuckPerms group holds game permissions, other plugins and meta. Only
    // known Zander nodes may ever be written.
    const { known, unmanaged } = partitionHeldNodes([
      "zander.web.forms",
      "essentials.fly",
      "zander.web.finance.*",
      "group.moderator",
      "zander.forums.moderate",
    ]);

    expect(known).toEqual(["zander.web.forms", "zander.forums.moderate"]);
    expect(unmanaged).toEqual(["essentials.fly", "zander.web.finance.*", "group.moderator"]);
  });

  it("treats a wildcard the rank already holds as unmanaged, not as a tick", () => {
    // It genuinely grants access, but this screen cannot represent or safely
    // remove it, so it is surfaced rather than silently dropped.
    const { known, unmanaged } = partitionHeldNodes(["*"]);

    expect(known).toEqual([]);
    expect(unmanaged).toEqual(["*"]);
  });

  it("copes with nothing, blanks and junk", () => {
    expect(partitionHeldNodes()).toEqual({ known: [], unmanaged: [] });
    expect(partitionHeldNodes(["", "   ", null])).toEqual({ known: [], unmanaged: [] });
  });
});
