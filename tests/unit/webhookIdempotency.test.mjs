import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Stripe retries webhook deliveries, and this app acknowledges the HTTP request
 * before processing begins — so a retry can arrive while the first delivery is
 * still crediting a purchase.
 *
 * The old guard was `if (await hasWebhookEvent(id)) return;` followed by the
 * work, which is check-then-act: two concurrent deliveries both read "not
 * processed" and both credit. claimWebhookEvent() replaces it with an atomic
 * INSERT against the stripeEventId UNIQUE index, so exactly one caller wins.
 */

const mockDbQuery = vi.fn();

vi.mock("../../controllers/databaseController.js", () => ({
  default: { query: mockDbQuery },
  prisma: {},
}));

const { claimWebhookEvent, recordWebhookEvent } = await import(
  "../../controllers/webstoreController.js"
);

/** A MySQL duplicate-key error as mysql2 surfaces it. */
function duplicateKeyError() {
  const err = new Error("ER_DUP_ENTRY: Duplicate entry for key 'stripeEventId'");
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

describe("claimWebhookEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims an unseen event", async () => {
    mockDbQuery.mockImplementation((sql, params, cb) => cb(null, { insertId: 1 }));

    await expect(claimWebhookEvent("evt_1", "checkout.session.completed")).resolves.toBe(true);
  });

  it("inserts rather than reading first, so the database arbitrates", async () => {
    mockDbQuery.mockImplementation((sql, params, cb) => cb(null, { insertId: 1 }));

    await claimWebhookEvent("evt_2", "checkout.session.completed");

    const sql = mockDbQuery.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO webstoreWebhookEvents/i);
    // A SELECT-then-INSERT would reintroduce the race this exists to remove.
    expect(sql).not.toMatch(/SELECT/i);
  });

  it("declines the claim when another delivery already won", async () => {
    mockDbQuery.mockImplementation((sql, params, cb) => cb(duplicateKeyError()));

    await expect(claimWebhookEvent("evt_3", "checkout.session.completed")).resolves.toBe(false);
  });

  it("only one of two concurrent deliveries wins", async () => {
    // First INSERT succeeds, the second hits the UNIQUE index — exactly what
    // MySQL does when both are in flight at once.
    let calls = 0;
    mockDbQuery.mockImplementation((sql, params, cb) => {
      calls += 1;
      if (calls === 1) return cb(null, { insertId: 1 });
      return cb(duplicateKeyError());
    });

    const results = await Promise.all([
      claimWebhookEvent("evt_race", "checkout.session.completed"),
      claimWebhookEvent("evt_race", "checkout.session.completed"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("propagates errors that are not duplicate-key, rather than silently crediting", async () => {
    const boom = new Error("connection lost");
    boom.code = "PROTOCOL_CONNECTION_LOST";
    mockDbQuery.mockImplementation((sql, params, cb) => cb(boom));

    // Returning false here would be wrong too — it would look like a duplicate
    // and silently drop a real event. It must surface.
    await expect(claimWebhookEvent("evt_4", "x")).rejects.toThrow("connection lost");
  });
});

describe("recordWebhookEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts, so filling in detail on a claimed row does not collide", async () => {
    mockDbQuery.mockImplementation((sql, params, cb) => cb(null, {}));

    await recordWebhookEvent({
      stripeEventId: "evt_5",
      purchaseId: 42,
      eventType: "checkout.session.completed",
      payload: { ok: true },
    });

    const sql = mockDbQuery.mock.calls[0][0];
    expect(sql).toMatch(/ON DUPLICATE KEY UPDATE/i);
  });

  it("does not blank an existing purchase link when called with null", async () => {
    mockDbQuery.mockImplementation((sql, params, cb) => cb(null, {}));

    await recordWebhookEvent({
      stripeEventId: "evt_6",
      purchaseId: null,
      eventType: "checkout.session.completed",
      payload: null,
    });

    // COALESCE keeps whatever the handler already attached.
    const sql = mockDbQuery.mock.calls[0][0];
    expect(sql).toMatch(/COALESCE\(VALUES\(purchaseId\), purchaseId\)/i);
  });
});
