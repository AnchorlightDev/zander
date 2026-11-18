import { describe, it, expect, vi, beforeEach } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("../../controllers/databaseController.js", () => ({ default: { query } }));
const action = await import("../../lib/scheduler/actions/wrapped.mjs");
const { setWrappedEnabled } = await import("../../controllers/wrappedController.js");

beforeEach(() => {
  query.mockReset();
  query.mockImplementation((sql, params, cb) => cb(null, {}));
});

describe("scheduled Wrapped availability", () => {
  it.each([["enable", 1], ["disable", 0]])("%s changes only the availability flag", async (mode, flag) => {
    expect(action.validate({ mode })).toEqual([]);
    expect(await action.run({ mode })).toMatchObject({ status: "succeeded" });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([flag]);
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE enabled = VALUES\(enabled\)/);
    expect(sql).not.toMatch(/periodStart|periodEnd|rollingMonths|musicUrl|wrappedRuns/);
  });
  it.each([undefined, "", "enabled", true])("rejects invalid mode %s without writing", async mode => {
    expect(action.validate({ mode })).not.toEqual([]);
    await expect(action.run({ mode })).rejects.toThrow(/mode/);
    expect(query).not.toHaveBeenCalled();
  });
  it("previews the effect without changing settings", () => {
    expect(action.preview({ mode: "disable" }).summary).toBe("Disable CFC Wrapped");
    expect(query).not.toHaveBeenCalled();
  });
  it("propagates database failures so the runner can record a failed action", async () => {
    query.mockImplementation((sql, params, cb) => cb(new Error("offline")));
    await expect(action.run({ mode: "enable" })).rejects.toThrow("offline");
  });
  it("rejects non-boolean controller input", async () => {
    await expect(setWrappedEnabled("false")).rejects.toThrow(/boolean/);
    expect(query).not.toHaveBeenCalled();
  });
});
