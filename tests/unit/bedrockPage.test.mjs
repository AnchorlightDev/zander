/**
 * tests/unit/bedrockPage.test.mjs
 *
 * Guards the standing constraint for the Bedrock page: nothing about one
 * particular community may be baked into the template or the copy.
 *
 * Connection details live in config.connection and copy lives in lang.json, so
 * a port or a hostname appearing in either the view or the language file is a
 * regression -- that is exactly how two pages end up advertising different
 * ports and Bedrock players end up unable to connect.
 *
 * Deliberately scoped to the Bedrock surfaces. Widening this to every view is
 * the job of the connection-details task, which has to remove the existing
 * hard-coded ports first; asserting it repo-wide today would just fail.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const view = readFileSync(join(repoRoot, "views/modules/play/bedrock.ejs"), "utf8");
const lang = JSON.parse(readFileSync(join(repoRoot, "lang.json"), "utf8"));
const features = JSON.parse(readFileSync(join(repoRoot, "features.json"), "utf8"));
const featuresExample = JSON.parse(readFileSync(join(repoRoot, "features.json.example"), "utf8"));

/**
 * The template minus its own commentary -- the assertions below are about the
 * code that renders, not the notes explaining why it renders that way.
 */
const code = view.replace(/<%#[\s\S]*?%>/g, "");

/**
 * Port-shaped, rather than "any four digits".
 *
 * A bare number is not evidence of anything -- the copy button has a 1500ms
 * timeout in it. What matters is a port in an address position (`host:19132`)
 * or one of the Minecraft defaults written out.
 */
const ADDRESS_PORT = /:\d{4,5}\b/;
const MINECRAFT_PORTS = [/\b19132\b/, /\b25565\b/];

describe("the Bedrock view holds no server-specific values", () => {
  it("contains no port literal", () => {
    for (const port of MINECRAFT_PORTS) {
      expect(code, String(port)).not.toMatch(port);
    }
    expect(code).not.toMatch(ADDRESS_PORT);
  });

  it("contains no hostname", () => {
    expect(code).not.toMatch(/\b[a-z0-9-]+\.(net|com|org|io|gg|au)\b/i);
  });

  it("names no particular community", () => {
    expect(code.toLowerCase()).not.toContain("crafting for christ");
    expect(code.toLowerCase()).not.toContain("craftingforchrist");
  });

  it("reads its connection details from the passed-in object, not from config directly", () => {
    // `bedrock` is resolved once in the route via lib/connectionDetails.mjs, so
    // the template never reaches into config.connection itself.
    expect(code).toContain("bedrock.host");
    expect(code).not.toContain("config.connection");
  });
});

describe("the Bedrock copy holds no connection details", () => {
  const copy = JSON.stringify(lang.bedrock);

  it("exists", () => {
    expect(lang.bedrock).toBeTypeOf("object");
  });

  it("has no port or hostname baked into it", () => {
    expect(copy).not.toContain("19132");
    expect(copy).not.toMatch(/\b[a-z0-9-]+\.(net|com|org|io|gg)\b/i);
  });

  it("uses tokens for anything server-specific", () => {
    expect(lang.bedrock.windowsSteps.join(" ")).toContain("%BEDROCK_HOST%");
    expect(lang.bedrock.windowsSteps.join(" ")).toContain("%BEDROCK_PORT%");
    expect(lang.bedrock.intro).toContain("%SITENAME%");
  });

  it("ships the access list empty, so nothing is claimed on an operator's behalf", () => {
    // What Bedrock players can reach differs per network. The section stays off
    // the page until somebody who knows fills this in.
    expect(lang.bedrock.access).toEqual([]);
  });

  it("covers every platform the page renders", () => {
    for (const key of ["windowsSteps", "mobileSteps", "consoleNote"]) {
      expect(lang.bedrock[key], key).toBeTruthy();
    }
  });
});

describe("the page is behind a feature flag", () => {
  it("is declared in both features files", () => {
    expect(features.bedrock).toBeTypeOf("boolean");
    expect(featuresExample.bedrock).toBeTypeOf("boolean");
  });
});
