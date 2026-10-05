import { describe, expect, it } from "vitest";
import { parsePageForm, slugFromPath, slugify } from "../../lib/customPages.mjs";

describe("slugify", () => {
  it("turns a title into a URL slug", () => {
    expect(slugify("Our Team!")).toBe("our-team");
    expect(slugify("  Café   Nights ")).toBe("cafe-nights");
    expect(slugify("---")).toBe("");
  });
});

describe("slugFromPath", () => {
  it("maps single-segment paths only", () => {
    expect(slugFromPath("/about")).toBe("about");
    expect(slugFromPath("/about/")).toBe("about");
    expect(slugFromPath("/about?ref=x")).toBe("about");
    expect(slugFromPath("/about/team")).toBeNull();
    expect(slugFromPath("/")).toBeNull();
    expect(slugFromPath("/favicon.ico")).toBeNull();
    expect(slugFromPath("/About")).toBeNull();
  });
});

describe("parsePageForm", () => {
  const body = { title: "About Us", slug: "", content: "<p>Hi</p>", status: "published" };

  it("derives the slug from the title when left blank", () => {
    const result = parsePageForm(body);
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ slug: "about-us", status: "published", metaDescription: null });
  });

  it("defaults an unknown status to draft", () => {
    expect(parsePageForm({ ...body, status: "live" }).value.status).toBe("draft");
  });

  it("refuses reserved slugs and slugs a route already owns", () => {
    expect(parsePageForm({ ...body, slug: "dashboard" }).ok).toBe(false);
    expect(parsePageForm({ ...body, slug: "rules" }, (slug) => slug === "rules").ok).toBe(false);
  });

  it("refuses malformed slugs and missing titles", () => {
    expect(parsePageForm({ ...body, slug: "Bad Slug" }).ok).toBe(false);
    expect(parsePageForm({ ...body, slug: "a--b" }).ok).toBe(false);
    expect(parsePageForm({ ...body, title: "" }).ok).toBe(false);
  });
});
