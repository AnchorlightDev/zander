# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

zander-web is the web + Discord-bot component of the Zander project: a Fastify web app (dashboard, public site, JSON API) combined with a Discord bot (Sapphire framework) sharing one database layer and one codebase. It talks to game servers via a companion Minecraft plugin ecosystem and to LuckPerms/LiteBans/QuickShop databases that live outside this app's own schema.

## Commands

```bash
npm run dev     # nodemon, local development
npm run prod    # production start (app.js directly, larger heap, experimental JSON modules)
npm run build   # npm install + prisma migrate deploy + prisma generate — used by the deploy pipeline
npm test        # vitest run (tests/unit + tests/integration, *.test.mjs / *.test.js)
```

Run a single test file: `npx vitest run tests/unit/permissions.test.mjs`

Database schema changes are Prisma-migration-only (no ORM query usage at runtime for most tables — see below). Add a new folder under `prisma/migrations/NNNN_description/migration.sql` (numeric-prefixed, sequential) and run `npx prisma migrate deploy`. `.env` is gitignored. There is no `config.json` or `features.json` — see Config layering.

## Architecture

### Two runtimes, one process

`app.js` boots a single Fastify app and, in parallel, imports `controllers/discordController.js` which spins up a Sapphire (`discord.js`-based) client. Discord slash commands live in `commands/*.mjs`, event listeners in `listeners/*.js`. Both runtimes share the same DB layer and `controllers/*` modules — a command handler and an HTTP route can call the exact same controller function.

Fastify plugins/routes are registered inside `buildApp()` in `app.js`. Route modules are plain functions taking `(app, config, features, ...)` and calling `app.get/post/patch/delete(...)` — there is no framework-level router file per feature; each domain has its own `routes/*.js` or `routes/dashboard/*.js` file that self-registers.

### Database: dual interface, one physical DB (+ external DBs)

`controllers/databaseController.js` exposes two ways to hit the primary database:
- `prisma` — a wrapped `PrismaClient` (write ops get a 30s hard timeout so a lock never hangs a request indefinitely). Prefer this for new code.
- `db` — a raw `mysql2` pool shim kept for backward compatibility with older callback-style controllers.

Schema changes always go through Prisma migrations (`prisma/migrations/`), but most controllers query with **raw SQL via the mysql2 pool** rather than Prisma Client models — Prisma here is a migration tool, not the primary query layer. Follow whatever pattern the controller you're editing already uses; don't silently convert raw-SQL controllers to Prisma Client calls.

Several *other* databases are connected via raw connection URLs (`LUCKPERMS_URL`, `QUICKSHOP_URL`, `PUNISHMENTS_URL`) for LuckPerms, QuickShop, and LiteBans (punishments) — these are external schemas this app reads/writes into but does not own or migrate.

### Config layering

- **Site settings and module switches live in the database**, edited at `/dashboard/settings` (`zander.web.settings`) and `/dashboard/modules` (`zander.web.modules`). There is no `config.json` or `features.json`. Load them with `const config = require("../lib/config/config.cjs")` / `require("../lib/config/features.cjs")` (via `createRequire`, since the project is `"type": "module"`). Every module shares the same two objects; `controllers/configSettingsController.js` writes the saved values into them at boot and on save, so read `config.x.y` / `features.x` at use time rather than copying at import.
- Layers: built-in defaults (`lib/config/defaults.cjs`) → a legacy `config.json`/`features.json` imported once into `siteSettings` (`legacy.config` / `legacy.features`) on the first boot that finds one on disk → per-field edits (`config:<path>` / `feature:<path>` rows). To add a setting: give it a default in `defaults.cjs`, and if staff should edit it, add it to `lib/config/settingsRegistry.mjs` (mark `restart: true` if a module copies it at import). New module switches only need a default in `defaults.cjs`. `web.login` cannot be switched from the dashboard, so nobody can lock themselves out.
- Feature flags gate entire modules/routes (e.g. `features.webstore`, `features.events`). Check the flag before assuming a module is reachable.
- `.env` — secrets and connection strings, read via `process.env.X` (dotenv loaded once in `app.js`/`api/common.js`). Never put secrets in site settings.
- `lang.json` — user-facing string overrides.

### Module pattern (self-contained feature slices)

Larger features (Webstore, Events, Finance, Watch/creator content) each follow the same shape: a `controllers/xController.js` data-access layer, a `routes/xRoutes.js` for public pages, a `routes/dashboard/x.js` + `views/dashboard/x/*.ejs` for the admin UI, and `api/routes/x.js` for JSON endpoints. When adding to an existing module, mirror its existing file split rather than inventing a new structure.

### Auth / permissions

Permissions are dot-notation LuckPerms nodes (e.g. `zander.web.webstore`), checked via `hasPermission(node, req, res, features)` from `api/common.js` for dashboard routes. Wildcards (`zander.web.*`, `*`) grant broader access — always check for both the specific node and its wildcard ancestors when writing new permission checks; the matching logic lives in `hasPermission` in `api/common.js`. Full permission node reference is in `README.md`.

Plugin-to-server ingestion endpoints use **per-client API credentials**, not session auth — see `api/routes/verifyToken.js`. Each caller (a Minecraft server, the uptime monitor, this app's own internal self-calls) has a row in `apiClients` holding a SHA-256 hash of its key plus an explicit scope list; keys look like `zdr_<prefix>_<secret>` and are matched by the non-secret prefix, then verified with `crypto.timingSafeEqual`. Scopes are coarse, one per API surface, with no wildcard — an unmapped path fails closed. Key format and scope resolution live in `lib/apiKeys.js` (no DB import, so it is unit-testable); the database side is `controllers/apiClientController.js`. Manage clients at `/dashboard/apikeys` (`zander.web.apikeys`). This app authenticates its own self-calls with `INTERNAL_API_KEY` via `internalApiHeaders()` in `api/common.js` — never reintroduce a shared `process.env.apiKey`. There is no shared-key fallback: a token that is not a well-formed `zdr_` client key is rejected with 401.

### Views

EJS templates under `views/`, rendered via `@fastify/view`. Static assets are served directly from `assets/` at `/`. Admin dashboard pages share chrome via `views/admin/_head.ejs`, `_topbar.ejs`, `_sidebar.ejs`, `_footer.ejs`; public module pages include `views/modules/header.ejs` and `views/modules/navigationBar.ejs` directly at the top of each template (see `views/modules/webstore/index.ejs`).

### Cron jobs

`cron/*.js` files are dynamically imported once, unconditionally, near the top of `app.js`. Each file is responsible for its own feature-flag/config gating internally (check `config.staffAuditReport?.enabled`-style guards inside the cron file, not in `app.js`) and registers itself with `node-cron` if enabled.
