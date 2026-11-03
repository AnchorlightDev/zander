import { describe, it, expect } from "vitest";
import { filterVisibleTools } from "../../lib/mcp/visibility.mjs";

const tools = [
  { name: "whoami" },
  { name: "events_list", feature: "events", permission: ["zander.web.events", "zander.web.events.edit"] },
  { name: "ranks_assign", feature: "ranks", permission: ["zander.web.rank"] },
  { name: "tickets_list", feature: "support", permission: ["zander.web.tickets"] },
];

const names = (list) => list.map((t) => t.name);

describe("filterVisibleTools", () => {
  it("shows only tools the caller holds a node for", () => {
    const user = { permissions: ["zander.web.events.edit"] };
    expect(names(filterVisibleTools(tools, { user, features: {} }))).toEqual(["whoami", "events_list"]);
  });

  it("honours wildcards", () => {
    const user = { permissions: ["zander.web.*"] };
    expect(names(filterVisibleTools(tools, { user, features: {} }))).toEqual(names(tools));
  });

  it("hides tools whose module is switched off", () => {
    const user = { permissions: ["*"] };
    const visible = filterVisibleTools(tools, { user, features: { ranks: false, support: true } });
    expect(names(visible)).toEqual(["whoami", "events_list", "tickets_list"]);
  });

  it("shows nothing but whoami to someone without nodes", () => {
    expect(names(filterVisibleTools(tools, { user: { permissions: [] }, features: {} }))).toEqual(["whoami"]);
  });
});
