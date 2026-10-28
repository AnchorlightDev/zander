import { describe, it, expect } from "vitest";
import { wantsNotificationSummary } from "../../lib/notificationScope.mjs";

describe("wantsNotificationSummary", () => {
  it("loads the bell for rendered pages", () => {
    for (const url of ["/", "/ranks", "/dashboard/events?page=2", "/forums/discussion/12", "/profile/some.user/x", "/profile/.Steve"]) {
      expect(wantsNotificationSummary(url)).toBe(true);
    }
  });

  it("skips static assets and the JSON API", () => {
    for (const url of [
      "/css/style.css",
      "/vendors/cdn/jquery/3.5.1/jquery.min.js",
      "/images/siteLogo.png?v=2",
      "/vendors/cdn/font-awesome/6.2.1/webfonts/fa-solid-900.woff2",
      "/manifest.webmanifest",
      "/api/web/statistics",
      "/api",
    ]) {
      expect(wantsNotificationSummary(url)).toBe(false);
    }
  });
});
