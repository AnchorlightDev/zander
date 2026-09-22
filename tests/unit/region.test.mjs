/**
 * tests/unit/region.test.mjs
 *
 * Reading the community's region out of config. Pure -- no config file.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getRegion } from "../../lib/region.mjs";
import { organizationNode } from "../../lib/seo/jsonLd.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const config = (region) => ({ siteConfiguration: { region } });

describe("getRegion", () => {
  it("derives both spellings from one configured fact", () => {
    // The whole point: og:locale and <html lang> are the same fact written two
    // ways, so neither is configured separately and they cannot disagree.
    const region = getRegion(config({ name: "Australia", countryCode: "AU", language: "en" }));

    expect(region).toEqual({
      name: "Australia",
      countryCode: "AU",
      language: "en",
      htmlLang: "en-AU",
      locale: "en_AU",
      configured: true,
    });
  });

  it("defaults the language to English", () => {
    expect(getRegion(config({ name: "Australia", countryCode: "AU" })).language).toBe("en");
  });

  it("normalises case", () => {
    const region = getRegion(config({ countryCode: "au", language: "EN" }));

    expect(region.countryCode).toBe("AU");
    expect(region.language).toBe("en");
    expect(region.htmlLang).toBe("en-AU");
  });

  it("works for somewhere that is not Australia", () => {
    const region = getRegion(config({ name: "Germany", countryCode: "DE", language: "de" }));

    expect(region.htmlLang).toBe("de-DE");
    expect(region.locale).toBe("de_DE");
  });

  it("falls back to the bare language when no country is set", () => {
    const region = getRegion(config({ language: "en" }));

    expect(region.htmlLang).toBe("en");
    expect(region.locale).toBe("en");
    expect(region.configured).toBe(false);
  });

  it("ignores a country code that is not alpha-2", () => {
    expect(getRegion(config({ countryCode: "AUS" })).countryCode).toBeNull();
    expect(getRegion(config({ countryCode: "1" })).countryCode).toBeNull();
    expect(getRegion(config({ countryCode: "" })).countryCode).toBeNull();
  });

  it("ignores a language that is not alpha-2, rather than emitting junk", () => {
    expect(getRegion(config({ language: "english" })).language).toBe("en");
    expect(getRegion(config({ language: 7 })).language).toBe("en");
  });

  it("is unconfigured when nothing is set, so nothing is claimed", () => {
    // An operator who has not said where they are must not have a region
    // invented for them on their own homepage.
    const region = getRegion({});

    expect(region.configured).toBe(false);
    expect(region.name).toBeNull();
    expect(region.countryCode).toBeNull();
  });

  it("survives a missing or junk config", () => {
    expect(getRegion(undefined).configured).toBe(false);
    expect(getRegion(null).language).toBe("en");
    expect(getRegion({ siteConfiguration: { region: "nonsense" } }).configured).toBe(false);
  });

  it("counts as configured on a name alone", () => {
    // Enough to say it in copy, even without the metadata half.
    expect(getRegion(config({ name: "Australia" })).configured).toBe(true);
  });
});

describe("Organization schema carries the region", () => {
  const withRegion = {
    siteConfiguration: {
      siteName: "Example Network",
      siteUrl: "https://example.net",
      region: getRegion({ siteConfiguration: { region: { name: "Australia", countryCode: "AU" } } }),
    },
  };

  it("emits the country and the area served", () => {
    const node = organizationNode(withRegion);

    expect(node.address).toEqual({ "@type": "PostalAddress", addressCountry: "AU" });
    expect(node.areaServed).toBe("Australia");
  });

  it("emits neither when no region is configured", () => {
    // An invented country in structured data is worse than a missing one.
    const node = organizationNode({
      siteConfiguration: { siteName: "Example", siteUrl: "https://example.net" },
    });

    expect(node.address).toBeUndefined();
    expect(node.areaServed).toBeUndefined();
  });
});

describe("no view hard-codes a country", () => {
  const header = readFileSync(join(repoRoot, "views/modules/header.ejs"), "utf8");
  const code = header.replace(/<%#[\s\S]*?%>/g, "");

  it("derives og:locale rather than stating one", () => {
    // This was literally hard-coded to en_AU while <html lang> said "en".
    expect(code).not.toContain('content="en_AU"');
    expect(code).toContain("region.locale");
  });

  it("derives html lang rather than stating one", () => {
    expect(code).not.toContain('<html lang="en">');
    expect(code).toContain("region.htmlLang");
  });

  it("names no country in the copy", () => {
    expect(code).not.toContain("Australia");
  });
});
