import { describe, expect, it } from "vitest";
import { buildOverview, greetingFor, stripMinecraftFormatting } from "../../lib/dashboard/overview.mjs";

const ALL = { support: true, events: true, forms: true, resources: true, bridge: true, forums: true, webstore: true, server: true, announcements: true };
const counts = {
  openTickets: 3,
  eventsAwaitingReview: 0,
  formSubmissions: 2,
  resourceSuggestions: 4,
  resourcesOverdue: 1,
  failedCommands: 0,
  members: 1200,
  newMembers: 15,
  forumPosts: 42,
  webstoreRevenue: "A$120.00",
  webstoreOrders: 1,
  servers: 4,
};

describe("buildOverview", () => {
  it("shows everything to someone with every permission", () => {
    const o = buildOverview(counts, { features: ALL, permissions: ["*"] });
    expect(o.attention.map((t) => t.label)).toEqual(["Open tickets", "Events to review", "Form submissions", "Resource suggestions"]);
    expect(o.attention.find((t) => t.label === "Resource suggestions").detail).toBe("1 overdue");
    expect(o.stats.find((t) => t.label === "Members").detail).toBe("+15 this week");
    expect(o.stats.find((t) => t.label === "Webstore this month")).toMatchObject({ value: "A$120.00", detail: "1 order" });
    expect(o.allClear).toBe(false);
  });

  it("hides failed commands at zero but keeps other queues at zero", () => {
    const o = buildOverview(counts, { features: ALL, permissions: ["*"] });
    expect(o.attention.some((t) => t.label === "Failed server commands")).toBe(false);
    expect(o.attention.find((t) => t.label === "Events to review").value).toBe(0);
  });

  it("only shows what the viewer can open", () => {
    const o = buildOverview(counts, { features: ALL, permissions: ["zander.web.dashboard", "zander.web.tickets"] });
    expect(o.attention.map((t) => t.label)).toEqual(["Open tickets"]);
    expect(o.stats.map((t) => t.label)).toEqual(["Forum posts this week"]);
    expect(o.actions).toEqual([]);
  });

  it("follows module switches", () => {
    const o = buildOverview(counts, { features: { ...ALL, support: false, webstore: false }, permissions: ["*"] });
    expect(o.attention.some((t) => t.label === "Open tickets")).toBe(false);
    expect(o.stats.some((t) => t.label === "Webstore this month")).toBe(false);
  });

  it("leaves out numbers that could not be read instead of showing a dash", () => {
    const o = buildOverview({ ...counts, openTickets: null, members: null }, { features: ALL, permissions: ["*"] });
    expect(o.attention.some((t) => t.label === "Open tickets")).toBe(false);
    expect(o.stats.some((t) => t.label === "Members")).toBe(false);
  });

  it("reports all clear when every queue is empty", () => {
    const zero = { ...counts, openTickets: 0, formSubmissions: 0, resourceSuggestions: 0, resourcesOverdue: 0 };
    expect(buildOverview(zero, { features: ALL, permissions: ["*"] }).allClear).toBe(true);
  });
});

describe("stripMinecraftFormatting", () => {
  it("removes legacy codes, hex colours and MiniMessage tags", () => {
    expect(stripMinecraftFormatting("&6Time for a fresh start! &rThe")).toBe("Time for a fresh start! The");
    expect(stripMinecraftFormatting("§6§lNEW: §fDevoteMe")).toBe("NEW: DevoteMe");
    expect(stripMinecraftFormatting("&#ff0000Red <gold><bold>Gold</bold></gold>")).toBe("Red Gold");
  });

  it("keeps ordinary text, including ampersands and angle brackets in prose", () => {
    expect(stripMinecraftFormatting("Rock & roll")).toBe("Rock & roll");
    expect(stripMinecraftFormatting("3 < 4")).toBe("3 < 4");
  });
});

describe("greetingFor", () => {
  it("follows the hour", () => {
    expect(greetingFor(8)).toBe("Good morning");
    expect(greetingFor(14)).toBe("Good afternoon");
    expect(greetingFor(21)).toBe("Good evening");
  });
});
