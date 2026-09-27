import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// In-memory siteSettings table.
const rows = new Map();
let dbDown = false;
const guard = () => { if (dbDown) throw new Error("connect ECONNREFUSED"); };

vi.mock("../../controllers/databaseController.js", () => ({
  prisma: {
    siteSettings: {
      findUnique: vi.fn(async ({ where }) => { guard(); return rows.get(where.settingKey) ?? null; }),
      findMany: vi.fn(async ({ where }) => {
        guard();
        const prefix = where.settingKey.startsWith;
        return [...rows.values()].filter((r) => r.settingKey.startsWith(prefix));
      }),
      upsert: vi.fn(async ({ where, create }) => {
        guard();
        const row = { settingKey: where.settingKey, settingValue: create.settingValue, updatedAt: new Date() };
        rows.set(where.settingKey, row);
        return row;
      }),
    },
  },
}));

let dir;
let cwd;

beforeEach(async () => {
  rows.clear();
  dbDown = false;
  vi.resetModules();
  // The shared store is CommonJS (Node's require cache), which resetModules
  // does not touch -- drop it so each boot starts from fresh defaults.
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  for (const key of Object.keys(require.cache)) {
    if (/[\\/]lib[\\/]config[\\/][^\\/]+\.cjs$/.test(key)) delete require.cache[key];
  }
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "zander-settings-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  const controller = await import("../../controllers/configSettingsController.js");
  await controller.applyConfigOverrides();
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  return { config: require("../../lib/config/config.cjs"), features: require("../../lib/config/features.cjs") };
}

describe("one-time import of legacy settings files", () => {
  it("imports config.json and an old features.json on first boot, keeping new flags on", async () => {
    writeFileSync("config.json", JSON.stringify({ siteConfiguration: { siteName: "Imported Site" }, meetings: { enabled: true } }));
    writeFileSync("features.json", JSON.stringify({ webstore: false })); // predates bedrock/birthday

    const { config, features } = await boot();

    expect(rows.get("legacy.config").settingValue.siteConfiguration.siteName).toBe("Imported Site");
    expect(config.siteConfiguration.siteName).toBe("Imported Site");
    expect(config.meetings).toEqual({ enabled: true });
    expect(features.webstore).toBe(false);
    expect(features.bedrock).toBe(true);
    expect(features.birthday).toBe(true);
  });

  it("ignores the files once the database holds the import", async () => {
    rows.set("legacy.config", { settingKey: "legacy.config", settingValue: { siteConfiguration: { siteName: "From DB" } }, updatedAt: new Date() });
    writeFileSync("config.json", JSON.stringify({ siteConfiguration: { siteName: "Stale File" } }));

    const { config } = await boot();
    expect(config.siteConfiguration.siteName).toBe("From DB");
  });

  it("applies dashboard edits over the imported base", async () => {
    rows.set("legacy.config", { settingKey: "legacy.config", settingValue: { siteConfiguration: { siteName: "Base" } }, updatedAt: new Date() });
    rows.set("config:siteConfiguration.siteName", { settingKey: "config:siteConfiguration.siteName", settingValue: "Edited", updatedAt: new Date() });
    rows.set("feature:birthday", { settingKey: "feature:birthday", settingValue: false, updatedAt: new Date() });

    const { config, features } = await boot();
    expect(config.siteConfiguration.siteName).toBe("Edited");
    expect(features.birthday).toBe(false);
  });

  it("uses defaults when there is no file and nothing saved", async () => {
    const { config, features } = await boot();
    expect(config.siteConfiguration.siteName).toBe("My Community");
    expect(features.webstore).toBe(true);
    expect(rows.has("legacy.config")).toBe(false);
  });

  it("still starts from a file on disk if the database is down, without importing", async () => {
    dbDown = true;
    writeFileSync("config.json", JSON.stringify({ siteConfiguration: { siteName: "Offline File" } }));

    const { config } = await boot();
    expect(config.siteConfiguration.siteName).toBe("Offline File");
    expect(rows.size).toBe(0);
  });
});
