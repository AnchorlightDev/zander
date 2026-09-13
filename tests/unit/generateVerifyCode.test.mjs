import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();

vi.mock("module", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => () => ({ siteConfiguration: {} }),
  };
});

vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: mockDbQuery },
}));

vi.mock("../../controllers/announcementController.js", () => ({
  getWebAnnouncement: vi.fn(),
}));

const { generateVerifyCode } = await import("../../api/common.js");

describe("generateVerifyCode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a 6-digit code that is not already active", async () => {
    mockDbQuery.mockImplementation((sql, params, cb) => cb(null, []));

    const code = await generateVerifyCode();

    expect(String(code)).toMatch(/^\d{6}$/);
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM userVerifyLink WHERE linkCode = ?"),
      expect.any(Array),
      expect.any(Function)
    );
  });

  it("regenerates when the first candidate collides with an active code", async () => {
    let call = 0;
    mockDbQuery.mockImplementation((sql, params, cb) => {
      call += 1;
      // First generated code is "active" (collision), second is free.
      cb(null, call === 1 ? [{ 1: 1 }] : []);
    });

    const code = await generateVerifyCode();

    expect(String(code)).toMatch(/^\d{6}$/);
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("falls back to a raw code if the collision check errors", async () => {
    mockDbQuery.mockImplementation((sql, params, cb) => cb(new Error("db down")));

    const code = await generateVerifyCode();
    expect(String(code)).toMatch(/^\d{6}$/);
  });
});
