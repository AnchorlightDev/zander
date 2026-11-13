import { describe, it, expect } from "vitest";
import { supportPanelRows } from "../../lib/supportPanelLayout.mjs";

const cats = (n) => Array.from({ length: n }, (_, i) => ({ categoryId: i + 1, name: `Cat ${i + 1}` }));

describe("supportPanelRows", () => {
  it("returns no rows when there are no categories", () => {
    expect(supportPanelRows([])).toEqual([]);
    expect(supportPanelRows(undefined)).toEqual([]);
  });

  it("keeps five or fewer categories on one row", () => {
    const rows = supportPanelRows(cats(5));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(5);
    expect(rows[0][0]).toEqual({ customId: "support_category_1", label: "Cat 1" });
  });

  it("splits a sixth category onto a second row", () => {
    const rows = supportPanelRows(cats(6));
    expect(rows.map((r) => r.length)).toEqual([5, 1]);
    expect(rows[1][0].customId).toBe("support_category_6");
  });

  it("caps the panel at 25 buttons in 5 rows", () => {
    const rows = supportPanelRows(cats(30));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.length === 5)).toBe(true);
  });

  it("truncates labels to Discord's 80-character limit and fills blank names", () => {
    const [[long, blank]] = supportPanelRows([
      { categoryId: 1, name: "x".repeat(120) },
      { categoryId: 2, name: "   " },
    ]);
    expect(long.label.length).toBe(80);
    expect(blank.label).toBe("Category 2");
  });
});
