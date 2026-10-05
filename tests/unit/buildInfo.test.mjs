import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { commitFromEnv, commitFromGitDir, resolveBuildInfo } from "../../lib/buildInfo.js";

const SHA = "7970e4f73d1b939ba83b41063f5f752e29f0af8a";

describe("commitFromEnv", () => {
  it("reads the commit a host or CI sets", () => {
    expect(commitFromEnv({ SOURCE_VERSION: SHA })).toBe(SHA);
    expect(commitFromEnv({ RENDER_GIT_COMMIT: SHA.toUpperCase() })).toBe(SHA);
  });

  it("ignores values that are not a commit", () => {
    expect(commitFromEnv({ GIT_COMMIT: "main" })).toBeNull();
    expect(commitFromEnv({})).toBeNull();
  });
});

describe("commitFromGitDir", () => {
  let gitDir;
  beforeEach(() => {
    gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildinfo-"));
  });
  afterEach(() => fs.rmSync(gitDir, { recursive: true, force: true }));

  it("follows HEAD to a loose branch ref", () => {
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/staging\n");
    fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "refs", "heads", "staging"), SHA + "\n");
    expect(commitFromGitDir(gitDir)).toBe(SHA);
  });

  it("finds a branch that only exists in packed-refs", () => {
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/master\n");
    fs.writeFileSync(path.join(gitDir, "packed-refs"), `# pack-refs with: peeled\n${SHA} refs/heads/master\n`);
    expect(commitFromGitDir(gitDir)).toBe(SHA);
  });

  it("reads a detached HEAD", () => {
    fs.writeFileSync(path.join(gitDir, "HEAD"), SHA + "\n");
    expect(commitFromGitDir(gitDir)).toBe(SHA);
  });

  it("is null without a checkout", () => {
    expect(commitFromGitDir(path.join(gitDir, "missing"))).toBeNull();
  });
});

describe("resolveBuildInfo", () => {
  it("prefers the environment and shortens the commit", () => {
    const info = resolveBuildInfo({ env: { GIT_COMMIT: SHA }, rootDir: os.tmpdir() });
    expect(info.commit).toBe(SHA);
    expect(info.shortCommit).toBe("7970e4f");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
