import { describe, it, expect, vi } from "vitest";

vi.mock("../../controllers/databaseController.js", () => ({ default: { query: vi.fn() } }));
vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));

const { isValidPushSubscription } = await import("../../controllers/notificationController.js");

const keys = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

describe("isValidPushSubscription", () => {
  it("accepts a browser push-service endpoint", () => {
    expect(isValidPushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys })).toBe(true);
    expect(isValidPushSubscription({ endpoint: "https://web.push.apple.com/QW9j", keys })).toBe(true);
    expect(isValidPushSubscription({ endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", keys })).toBe(true);
  });

  it("rejects endpoints that would make the server call arbitrary hosts", () => {
    expect(isValidPushSubscription({ endpoint: "http://fcm.googleapis.com/x", keys })).toBe(false);
    expect(isValidPushSubscription({ endpoint: "https://10.0.0.5:8080/admin", keys })).toBe(false);
    expect(isValidPushSubscription({ endpoint: "https://evil.test/fcm.googleapis.com", keys })).toBe(false);
    expect(isValidPushSubscription({ endpoint: "https://fcm.googleapis.com.evil.test/x", keys })).toBe(false);
  });

  it("rejects malformed keys", () => {
    expect(isValidPushSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "short", auth: keys.auth } })).toBe(false);
    expect(isValidPushSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: keys.p256dh, auth: "not base64url!" } })).toBe(false);
    expect(isValidPushSubscription({ endpoint: "https://fcm.googleapis.com/x" })).toBe(false);
    expect(isValidPushSubscription(null)).toBe(false);
  });
});
