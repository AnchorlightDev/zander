"""Surgical edits to shared Zander files for the Credential Vault.

Each edit replaces one exact anchor and fails loudly if the anchor is missing
or not unique, so it can be replayed safely on a working tree with other
uncommitted changes. Usage: python3 .cv_shared_edits.py <repo root>
"""
import sys, pathlib

root = pathlib.Path(sys.argv[1])

EDITS = [
    ("lib/config/defaults.cjs", '      forumLog: "",\n', '      forumLog: "",\n      credentialVault: "",\n'),
    ("lib/config/defaults.cjs", "  vault: true,\n", "  vault: true,\n  // Off until CREDENTIAL_VAULT_KEKS is set and the security review is done.\n  credentialVault: false,\n"),
    (
        "lib/config/featureRegistry.mjs",
        '  "web.register": {',
        '  credentialVault: {\n    label: "Credential vault",\n    description: "Shared staff credentials with per-access reauthentication. Needs CREDENTIAL_VAULT_KEKS in .env; see docs/credential-vault-architecture.md.",\n  },\n  "web.register": {',
    ),
    (
        "lib/config/settingsRegistry.mjs",
        '      webhook("discord.webhooks.forumLog", "Forum log webhook", { help: "Where new forum posts and moderation actions are logged." }),\n',
        '      webhook("discord.webhooks.forumLog", "Forum log webhook", { help: "Where new forum posts and moderation actions are logged." }),\n'
        '      webhook("discord.webhooks.credentialVault", "Credential vault webhook", { help: "Administrator alerts from the credential vault (never secret values)." }),\n',
    ),
    (
        "lib/config/settingsRegistry.mjs",
        '  vault: { links: [{ label: "Vault", href: "/dashboard/vault" }] },\n',
        '  vault: { links: [{ label: "Vault", href: "/dashboard/vault" }] },\n'
        '  credentialVault: {\n    fields: ["discord.webhooks.credentialVault"],\n    links: [{ label: "Credential vault", href: "/dashboard/credentials" }],\n  },\n',
    ),
    (
        "lib/permissions/zanderNodes.mjs",
        '      { node: "zander.web.vault", description: "Access vault management" },\n',
        '      { node: "zander.web.vault", description: "Access vault management" },\n'
        '      {\n        node: "zander.web.credentials",\n        description: "Open the credential vault. Grants no credentials: vault access is assigned inside the vault",\n      },\n',
    ),
    (
        "admin/pageRegistry.js",
        '  {\n    slug: "apikeys",',
        '  {\n    slug: "credentials",\n    title: "Credential Vault",\n    menuTitle: "Credential Vault",\n    icon: "fa-solid fa-vault",\n'
        '    capability: "zander.web.credentials",\n    path: "/dashboard/credentials",\n    featureFlag: "credentialVault",\n    group: "System",\n    sortOrder: 74,\n  },\n'
        '  {\n    slug: "apikeys",',
    ),
    (
        "routes/dashboard/index.js",
        'import dashboardHologramsRoute from "./holograms.js";\n',
        'import dashboardHologramsRoute from "./holograms.js";\nimport dashboardCredentialVaultRoute from "./credentials.js";\n',
    ),
    (
        "routes/dashboard/index.js",
        "  dashboardHologramsRoute(app, config, db, features, lang);\n",
        "  dashboardHologramsRoute(app, config, db, features, lang);\n  dashboardCredentialVaultRoute(app, config, features, lang);\n",
    ),
    (
        "api/common.js",
        "function hasSpecificPermission(permissionArray, node) {",
        "export function hasSpecificPermission(permissionArray, node) {",
    ),
    (
        "app.js",
        'import("./cron/shopItemIndexCron.js");\n',
        'import("./cron/shopItemIndexCron.js");\nimport("./cron/credentialVaultCron.js");\n',
    ),
    (
        "package.json",
        '    "bcrypt": "^6.0.0",\n',
        '    "argon2": "^0.45.1",\n    "bcrypt": "^6.0.0",\n',
    ),
    (
        ".env.example",
        "MINEMONITOR_CONNECTION_TOKEN=\n",
        "MINEMONITOR_CONNECTION_TOKEN=\n\n"
        "# ── Credential Vault ────────────────────────────────────────────────────────\n"
        "# Key-encryption keys for the credential vault: comma-separated id:base64 pairs,\n"
        "# each exactly 32 bytes. Generate one with `node admin/credential-vault.mjs keygen`.\n"
        "# Keep an offline escrow copy: losing every copy of a key loses every secret it\n"
        "# protects. Leave blank and the vault stays unavailable. Never commit real keys.\n"
        "# See docs/credential-vault-architecture.md for rotation.\n"
        "CREDENTIAL_VAULT_KEKS=\n"
        "# The id (from CREDENTIAL_VAULT_KEKS) that new data keys are wrapped with.\n"
        "CREDENTIAL_VAULT_ACTIVE_KEK=\n",
    ),
    (
        "CHANGELOG.md",
        "## Unreleased\n\n",
        "## Unreleased\n\n"
        "### Added\n\n"
        "- **Credential Vault** (`/dashboard/credentials`, off by default). Shared staff credentials -- logins, API keys, development secrets, recovery codes and secure notes -- encrypted with per-credential keys under a key-encryption key held outside the database (`CREDENTIAL_VAULT_KEKS`). Every reveal, copy or history access asks for the person's password again through a single-use, 30-second, action-specific challenge; administrators get no automatic access to secrets. Collections, permission groups, allow/deny grants with expiry, access requests and approvals, encrypted version history, credential health, rotation tasks, offboarding, a hash-chained audit log and notifications. Staff without a Zander password set a dedicated vault password with a one-time code from a vault administrator. Entry node `zander.web.credentials`; needs `npm install` for the new `argon2` dependency and migration `0077`. Not yet approved for production secrets: see `docs/credential-vault-architecture.md`.\n\n",
    ),
]

failed = False
for rel, old, new in EDITS:
    path = root / rel
    with open(path, encoding="utf-8", newline="") as fh:
        text = fh.read()
    if "\r\n" in text:
        old = old.replace("\n", "\r\n")
        new = new.replace("\n", "\r\n")
    if new in text:
        print(f"skip (already applied): {rel}")
        continue
    count = text.count(old)
    if count != 1:
        print(f"FAIL {rel}: anchor found {count} times: {old[:60]!r}")
        failed = True
        continue
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text.replace(old, new, 1))
    print(f"ok: {rel}")

sys.exit(1 if failed else 0)
