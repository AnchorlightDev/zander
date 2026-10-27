# API client credentials

Every caller of the JSON API — each Minecraft server plugin, the uptime monitor,
and this app's own internal self-calls — authenticates with its own credential
rather than a single shared secret. A compromised or retired caller is revoked
on its own, without touching any other.

## Issuing a key

1. Go to **Dashboard → System → API Keys** (`/dashboard/apikeys`, requires
   `zander.web.apikeys`).
2. Give the client a name that identifies the caller, e.g. `survival-server`
   or `uptime-monitor`.
3. Tick only the scopes that caller needs.
4. Copy the key it shows you. **It is displayed once.** Only a SHA-256 hash is
   stored, so a lost key cannot be recovered — revoke the client and issue a
   new one.

Keys look like `zdr_<8-char prefix>_<40-char secret>`. The prefix is a
non-secret lookup handle and is safe to quote in logs and support tickets; the
secret is not.

## Scopes

One scope per API surface, with **no wildcard** — granting broad access has to
be a deliberate act of selecting every box:

`announcement`, `application`, `badges`, `bridge`, `config`, `discord`,
`events`, `filter`, `finance`, `hologram`, `punishments`, `ranks`, `report`, `scheduler`,
`server`, `session`, `shopdirectory`, `user`, `vault`, `web`, `adminUsers`,
`internal`

A request to a path with no scope mapping is rejected, so a newly added route
is unreachable until it is deliberately given a scope.

## Responses

| Situation | Status |
|---|---|
| Missing or malformed key | `401` |
| Unknown prefix, wrong secret, or revoked client | `401` |
| Valid key without the required scope | `403` |
| Client lookup failed (database unreachable) | `503` |

The body keeps the usual `{ success, message }` shape.

## This app's own calls

The app calls its own API in a number of places (`api/internal_redirect/*`,
several dashboard routes and Discord commands). It uses a dedicated client —
conventionally named `zander-web-internal` — supplied via `INTERNAL_API_KEY`
and applied through `internalApiHeaders()` in `api/common.js`. Never reintroduce
a shared key that the app both presents and validates.

## Revocation

Revoking is a soft delete: the row is kept for audit with `isRevoked` and
`revokedAt` set, and the auth cache entry is evicted immediately so the key
stops working straight away.
