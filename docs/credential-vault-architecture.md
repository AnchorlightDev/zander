# Credential Vault — architecture, threat model and operations

Status: implemented on `feat/credential-vault`, **not yet approved for production secrets**.
The module ships switched off (`features.credentialVault = false`) and its pages
refuse to work until a key-encryption key is configured. Do not store real
organisational credentials until the independent review in §11 is complete.

This file is the design record for reviewers and operators. When the feature is
released, the user-facing parts move to the docs site
(anchorlight.dev/docs/products/zander) like the rest of the Zander documentation.

## 1. What it is

A Bitwarden-style shared credential store inside the Zander staff dashboard
(`/dashboard/credentials`) for organisation-owned accounts: social media,
hosting, Minecraft infrastructure, API keys, SSH keys, recovery codes and
secure notes. Types: Login, API credential, Development secret, Recovery
information, Secure note, plus per-credential custom fields that can each be
marked secret.

## 2. Trust boundaries and assets

| Asset | Where it lives | Protected by |
|---|---|---|
| Secret values (passwords, keys, codes, notes, secret custom fields) | `credentialSecretVersions.ciphertext` | AES-256-GCM under a per-credential data key (DEK) |
| Per-credential DEKs | `credentialKeys.wrappedKey` | AES-256-GCM under the key-encryption key (KEK) |
| KEK(s) | `CREDENTIAL_VAULT_KEKS` env var on the host + offline escrow | Host access controls; never in the DB, Git, logs or Sentry |
| Reuse-detection key | `credentialVaults.wrappedFingerprintKey` | Wrapped by the KEK |
| Vault-access passwords | `credentialVaultPasswords.verifier` | Argon2id (m=19 MiB, t=2, p=1) |
| Enrolment codes | `credentialVaultPasswords.enrolmentCodeHash` | SHA-256 of a ~98-bit one-time code, 24 h expiry |
| Metadata (names, URLs, usernames) | `credentials` | Server-side permission checks only (not encrypted) |
| Audit trail | `credentialAuditEvents` | Append-only code path + SHA-256 hash chain with head and retention anchor |

Actors: staff with vault grants, vault administrators (`manage_vault`),
access approvers, the Zander server process, database operators, Render
operators, and an attacker holding any one of: a stolen session cookie, a
database dump, a backup, Sentry/log access, or a staff member's Discord account.

## 3. Encryption model (server-managed envelope encryption)

- Each credential has a random 256-bit DEK. The secret fields of a version are
  serialised to JSON and encrypted once with AES-256-GCM (random 96-bit nonce,
  128-bit tag), AAD = `zander-cv/secret/v1|vault:<id>|cred:<id>|ver:<n>`, so a
  ciphertext copied onto another credential or version fails to decrypt.
- The DEK is wrapped with the active KEK (AES-256-GCM, AAD =
  `zander-cv/dek/v1|cred:<id>|kek:<kekId>`) and stored with the KEK id.
- KEKs come from a key provider (`lib/credentialVault/crypto.mjs`). The shipped
  provider reads `CREDENTIAL_VAULT_KEKS="k1:<base64>,k2:<base64>"` and
  `CREDENTIAL_VAULT_ACTIVE_KEK=k2`. A cloud KMS provider can replace it by
  implementing `activeKekId`, `wrap()` and `unwrap()`; nothing else changes.
- Data keys are zeroed after use. Moving a credential between collections does
  not touch keys: the AAD binds the credential id, not the collection.
- Weak/reused password detection: at save time the server stores a 0–4
  strength estimate and a keyed HMAC fingerprint of the `password` field.
  Nothing is sent to third-party breach services.

**This is not zero-knowledge.** The server process holds the KEK and can decrypt
any secret; someone with both the database and the host environment can decrypt
everything. What the design guarantees:

- A database dump or backup alone exposes no secret value.
- No HTTP route returns a plaintext secret except the challenge-verify route,
  and only after a successful, single-use, per-action reauthentication.
- Administrative capabilities give no decryption path through the application.

A client-side (end-to-end) model was considered and rejected for the first
release: Discord-only staff have no stable secret to derive keys from, every
browser would need key enrolment and per-user key wrapping, and organisational
recovery would need an escrow key the server then holds anyway. The envelope
design keeps that option open (`credentialKeys` can gain per-user wrapped copies).

## 4. Mandatory reauthentication

### Factor per account

| Account | Factor at every secret access |
|---|---|
| Has a Zander password (`users.password_hash`) | The Zander account password (bcrypt, existing hash) |
| Discord-only (no password) | A dedicated vault password (Argon2id) |
| Anyone, when *Require a dedicated vault password* is on | The vault password |

Discord OAuth cannot prove a fresh sign-in (no `auth_time`/`max_age`;
`prompt=consent` is not reauthentication), so it is never accepted as a factor,
and being signed in is never enough to set one up. Fail closed: no eligible
factor → no secret.

### Enrolling a vault password

- Staff with a Zander password: re-enter it. It is checked before the new
  password's policy, so the "must differ from your account password" rule
  cannot be used to test guesses.
- Discord-only staff: enter a one-time **enrolment code** issued by a *different*
  vault administrator (Administration → Issue an enrolment code, shown once,
  passed on in person or by private message). Codes are single-use, expire after
  24 hours, and are stored only as a hash. Issuing a new code cancels the old one.
- Every enrolment attempt counts against the lockout.
- Changing a vault password requires the current one. A forgotten vault password
  is cleared by another vault administrator (audited, user notified); the user
  then re-enrols as above. There is no email-based reset.

Known trade-off (chosen deliberately): an account password can be reset by
email code, so for password-account staff the vault is as strong as their
mailbox. Turning on *Require a dedicated vault password* removes that.

### One-time, action-specific authorisation

1. `POST /dashboard/credentials/api/challenges` with
   `{credentialId, action, field, versionId?}`. The server checks the module
   switch, login, entry node, account state, credential existence, the user's
   effective capability for that action, and that the field holds a value. It
   issues a 32-byte random token; only its SHA-256 is stored, bound to user,
   session (hash of the session id), credential, action, field and version,
   expiring in ≤ 30 s (hard ceiling).
2. The modal posts `{challengeToken, password}` to
   `POST /dashboard/credentials/api/challenges/verify`. The route strips both
   from the request body before anything else runs.
3. The server **claims the challenge first** with one atomic
   `UPDATE … SET status='consumed' WHERE tokenHash=? AND status='pending'
   AND expiresAt > ? AND userId=? AND sessionHash=?` (the time is passed in from
   the application). Exactly one request can win; a wrong password burns the
   challenge, so each challenge allows one guess.
4. One attempt is **reserved** against the lockout counter atomically (only while
   not locked and below the limit), then the factor is verified.
5. Account state, the credential and the user's permission are re-read from the
   database, so revocation, deletion and suspension take effect immediately,
   even inside an active Zander session.
6. Only the requested field of the requested version is decrypted and returned,
   with `Cache-Control: no-store`. Actions: `reveal`, `copy`, `reveal_version`,
   `restore_version` (restore returns no secret).

Every action needs its own challenge: a copy after a reveal, a second reveal a
second later, a different credential. There is no unlocked vault, collection or
session state. Tokens live in a JS variable for ≤ 30 s and never in storage.
Pending challenges are revoked when access is revoked, the credential is deleted,
the vault password changes or the user is offboarded.

Brute force: one guess per challenge; per-IP limits on challenge creation
(30/min) and verification (10/min); per-user lockout after N failures
(default 5) for M minutes (default 15), audited, administrators notified. A
counter stranded at the limit by a crash becomes an ordinary expiring lock.

MFA: Zander has no MFA today, so none is enforced. When MFA is added, it slots
into step 4 as an additional verifier.

## 5. Permission model

Vault permissions are separate from LuckPerms ranks. `zander.web.credentials` is
only an entry gate (menu + pages); it grants no credential. Authority comes from
`credentialGrants`:

- Scope: `vault`, `collection` or `credential`.
- Principal: a user, or a vault permission group (`credentialGroups`, explicit
  membership with optional expiry). Seeded groups: Social Media Team,
  Development Team, Infrastructure Team, Senior Staff, Credential Administrators.
- Effect: `allow` or `deny`. Deny wins at any scope and through any group. A deny
  on `view` removes everything that implies view; a deny on `list` hides the item.
- Capabilities: `list`, `view`, `reveal`, `copy`, `create`, `edit`, `delete`,
  `view_history`, `manage_access`, `manage_collections`, `view_audit`,
  `approve_requests`, `manage_vault`. Any credential capability implies
  `list` + `view`. **`manage_vault` does not imply `reveal` or `copy`.**
- Optional expiry; expired grants stop working at that instant and are swept by
  cron (audited, user notified).

Evaluated server-side on every request from the database. Guards:

- Nobody grants to themselves or a group they belong to, or changes their own
  group membership, resets their own vault password, issues their own enrolment
  code or offboards themselves.
- Without `manage_vault`, you can only grant capabilities you hold on that target,
  never vault-wide. Lifting a deny counts as granting what it removed.
- Approvers (`approve_requests`) can approve only capabilities they hold (vault
  administrators excepted), never their own request, and may shorten but not
  extend a requested duration.
- Moving a credential needs `manage_access` on it and on the destination (or
  `manage_vault`), and is refused if it would widen the mover's own access.
- Users with only `list` see names, types, collections and sites; usernames,
  emails and tags are hidden and are not searchable for them.
- Unauthorised and missing records give the same 404, so ids cannot be probed.

Visibility accepted by design: vault-wide `manage_vault` / `view_audit` holders
see credential metadata (names, sites, usernames) on the health, audit, trash and
offboarding pages — never secret values. The Discord webhook carries only event
titles and links.

## 6. Audit

Every security-relevant action writes `credentialAuditEvents` with actor,
subject user, credential, collection, outcome, a short session hash, IP, user
agent and whitelisted non-sensitive metadata. A sanitiser drops any key that
names a secret field, password, token or key.

Rows are hash-chained through a single locked head row (`credentialAuditHead`).
Verification (Activity → *Verify integrity*, or `node admin/credential-vault.mjs
verify-audit`) checks every link, that the first retained event follows the
retention anchor, and that the newest event matches the head — so edits,
deletions in the middle, and deletions at either end are detected. Limitation:
the chain is unkeyed, so someone with database write access could rebuild all of
it; for stronger guarantees, export the head hash somewhere outside the database
periodically. Retention (default 730 days) trims from the oldest end only.

## 7. Browser handling

No secret is rendered into HTML; the edit form never receives stored values
(blank = keep, tick to remove, type to replace). Revealed values are written with
`textContent` for the configured period (default 15 s) and wiped on timeout,
*Hide*, tab hide, page hide and back/forward restore. Copy writes to the
clipboard without rendering; optional best-effort clipboard clearing (not
guaranteed by any OS). Every vault response is `no-store`; `assets/sw.js` has no
fetch handler, so nothing is cached offline (a unit test keeps it that way).
Reload, logout or back-navigation always needs a new challenge.

## 8. Organisational recovery and offboarding

Credentials are organisation-owned and encrypted under the server KEK, so a staff
member leaving loses no data. Recovery authority = vault administrators
re-granting access, every grant audited. KEK custody: the host environment plus
an offline escrow copy split between two named trustees (record who). Losing
every copy of the KEK loses every secret — test restoration (§9) before go-live.

Offboarding (Administration → Offboard staff): preview, then revoke the person's
direct grants and group memberships, cancel pending challenges, clear their vault
password, optionally end all their Zander sessions, and open rotation tasks for
every credential they could reveal/copy or did reveal/copy. Administrators are
notified. Removing someone from Zander does not invalidate what they already saw:
rotate those credentials at the source service, then edit the credential with
*This change is a rotation* ticked (closes the task).

## 9. Backups

Encrypted rows are in the normal database backup. The KEK must be backed up
separately (escrow above). Restoration test before go-live: restore a backup into
a scratch database, start Zander against it with the escrowed KEK, reveal one
test credential, and verify the audit chain.

## 10. Operations

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `CREDENTIAL_VAULT_KEKS` | Yes | Comma-separated `id:base64key` pairs, each exactly 32 bytes. Generate with `node admin/credential-vault.mjs keygen`. |
| `CREDENTIAL_VAULT_ACTIVE_KEK` | Yes | The id new data keys are wrapped with. |

Optional: Site Settings → Discord → *Credential vault webhook* for administrator
alerts. New dependency: `argon2` (prebuilt binaries for Windows/Linux x64).

### First deployment

1. `npm install` (adds `argon2`), deploy; `npm run build` applies migration
   `0077_credential_vault`.
2. `node admin/credential-vault.mjs keygen` → put the line in
   `CREDENTIAL_VAULT_KEKS`, set `CREDENTIAL_VAULT_ACTIVE_KEK`, store the escrow copy.
3. Restart. `node admin/credential-vault.mjs status` should list the key id.
4. Give `zander.web.credentials` to every rank whose members will use the vault (it only opens the module; access inside is assigned separately).
5. `node admin/credential-vault.mjs bootstrap <username>` for the first vault
   administrator (grants `manage_vault`, `manage_collections`, `view_audit`,
   `approve_requests`, `create` — no reveal/copy).
6. Switch on *Credential vault* at `/dashboard/modules`.
7. In the vault: set up groups, collection access, and enrolment codes for
   Discord-only staff.

### Key rotation

Add the new key to `CREDENTIAL_VAULT_KEKS`, make it `CREDENTIAL_VAULT_ACTIVE_KEK`,
restart, run `node admin/credential-vault.mjs rewrap`, verify a reveal works,
then remove the old key and restart. Ciphertexts are untouched; only wrapped keys change.

### Scheduled jobs

`cron/credentialVaultCron.js` (only when the module is on and configured): every
10 minutes marks expired temporary access, closes stale requests, purges spent
challenges and opens rotation tasks that are due; daily at 03:17 trims the audit
log to its retention.

## 11. Not done / needs review before production

- Independent security review of this module (an internal adversarial review was
  run and its findings fixed; a human review is still required).
- Encrypted attachments — blocked on a malware-scanning service.
- Import (Bitwarden CSV/JSON) and per-credential export — not shipped. Bulk
  plaintext export is intentionally absent.
- Browser extension, CLI, automated rotation, breach checks, passkeys/hardware
  keys, multiple vaults (`vaultId` is in the schema), KMS provider (interface only).
