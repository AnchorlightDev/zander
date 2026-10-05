/**
 * tests/unit/zanderNodes.test.mjs
 *
 * The permission registry, and the invariant that keeps it honest: it must
 * match the table in README.md.
 *
 * Without this the checklist quietly goes stale -- a node added to the code
 * and documented in the README would simply never appear as a tick box, and
 * nobody would notice because nothing breaks.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  PERMISSION_GROUPS,
  grantableGroups,
  isGrantableNode,
  listAllNodes,
  listGrantableNodes,
  partitionHeldNodes,
} from "../../lib/permissions/zanderNodes.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

/** Every `| \`zander.x.y\` |` row in the README's permission tables. */
function documentedNodes() {
  return [...readme.matchAll(/^\|\s*`(zander\.[^`]+)`\s*\|/gm)].map((m) => m[1]);
}

describe("the registry matches the README", () => {
  it("documents every node the registry knows", () => {
    const documented = new Set(documentedNodes());
    const missing = listAllNodes().filter((node) => !documented.has(node));

    expect(missing, `in the registry but not documented in README.md: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("registers every node the README documents", () => {
    const registered = new Set(listAllNodes());
    const missing = documentedNodes().filter((node) => !registered.has(node));

    expect(missing, `documented in README.md but missing from the registry: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("covers a meaningful number of nodes, so a broken parse cannot pass quietly", () => {
    expect(documentedNodes().length).toBeGreaterThan(40);
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

  it("keeps the README's grouping", () => {
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
