/**
 * lib/buildInfo.js
 *
 * The running version (package.json) and commit, worked out once at boot and
 * shown in the site and dashboard footers so it is clear what is deployed.
 *
 * The commit comes from the host's build environment where it sets one, and
 * otherwise from the checkout's .git directory. Read directly rather than by
 * running `git`, which a production host may not have installed.
 */

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Variables CI systems and hosts set to the deployed commit. */
const COMMIT_ENV_VARS = [
  "GIT_COMMIT",
  "COMMIT_SHA",
  "SOURCE_VERSION", // Heroku
  "RENDER_GIT_COMMIT",
  "RAILWAY_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "GITHUB_SHA",
];

const SHA = /^[0-9a-f]{7,40}$/i;

export function commitFromEnv(env = process.env) {
  for (const name of COMMIT_ENV_VARS) {
    const value = String(env[name] || "").trim();
    if (SHA.test(value)) return value.toLowerCase();
  }
  return null;
}

/**
 * The commit HEAD points at in a checkout: a detached HEAD holds the sha,
 * otherwise follow the branch ref, which may only exist in packed-refs.
 */
export function commitFromGitDir(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (SHA.test(head)) return head.toLowerCase();

    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!ref) return null;

    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) {
      const sha = fs.readFileSync(loose, "utf8").trim();
      return SHA.test(sha) ? sha.toLowerCase() : null;
    }

    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && SHA.test(sha)) return sha.toLowerCase();
    }
  } catch {
    // No checkout (or unreadable) -- the commit is simply unknown
  }
  return null;
}

export function resolveBuildInfo({ env = process.env, rootDir = REPO_ROOT } = {}) {
  const { version } = require("../package.json");
  const commit = commitFromEnv(env) || commitFromGitDir(path.join(rootDir, ".git"));
  return {
    version: version || null,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : null,
  };
}

export const buildInfo = resolveBuildInfo();
