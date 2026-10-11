# Changelog

## Unreleased

### Security
- Public registration can no longer overwrite the credentials of an existing account that is Discord-linked, verified or registered; it only claims bare profile rows or an unfinished local registration.
- Staff recovery actions (change email, trigger password reset) refuse accounts that hold permissions the actor lacks, a staff-set email is unverified until confirmed, and resets require a verified address.
- Discord login carries an OAuth `state` parameter; the `discordId` cookie used during account linking is signed and the link code endpoint is throttled and reads the id from that cookie, not the form.
- Dashboard proxies (badges, bridge) only forward integer ids, closing a path traversal that reached other internal API endpoints with the internal key.
- Ticket category management moved behind the new `zander.web.tickets.manage` node; the view node no longer lets anyone rename or cascade-delete categories.
- Cookie-authenticated writes are rejected when the browser reports a cross-site origin (Sec-Fetch-Site / Origin), on both site routes and session-authenticated API routes.
- Rate limiting and audit IPs use `req.ip` behind an explicit proxy hop count (`TRUST_PROXY_HOPS`) instead of the client-controlled first X-Forwarded-For entry; emailed codes are invalidated after five wrong guesses; forgot-password, Minecraft code entry and ticket creation are throttled.
- Password resets invalidate the account's other sessions. The app refuses to start with the example session secret.
- Uploads: 8 MB limit actually enforced (was 1 MiB with a 500), folder restricted by permission, magic-byte and Cloudinary format checks, rate limited; duplicate dashboard handler removed.
- Web push subscriptions must point at a known push service (blind SSRF). Profile social fields are validated (Reddit must be an https reddit.com URL). Vault descriptions are sanitised; announcement, application, vault and event links must be http(s)/mailto/site paths.
- Rich-text sanitiser no longer allows arbitrary `class` values, protocol-relative URLs or unbounded nesting. `/api` 5xx responses no longer echo internal error text. Sentry no longer receives request bodies or cookies.
- LuckPerms rank slugs are validated before use in LIKE patterns; QuickShop and user searches escape LIKE wildcards. `multipleStatements` is off on the main pool.
- Privileged slash commands are guild-only. Rank-permission holders cannot grant nodes to a rank they hold. Placeholder user rows no longer shadow real players in username lookups, nickname enforcement or the birthday rank grant (which now addresses players by UUID).

### Fixed
- Rank/Discord role sync no longer strips a rank's role from every member when that one rank's lookup fails, and runs are serialised.
- Expired Discord bans/mutes stay active and retry when the Discord call fails instead of being marked expired; `/punish unban` keeps the record if Discord refused.
- Finance month ranges include the last day of the month; a paid webstore order whose item cannot be resolved is marked `failed`, not `fulfilled`; Stripe catalogue fetches are cached for a minute with a timeout.
- Audit timestamp updates no longer throw `ReferenceError` on DB errors; Prisma write-timeout timers are cleared; webhook clients in message listeners are destroyed; Twitch/YouTube crons do not mark every stream offline during an API outage.
- Unverified users can request a new email verification code (resend button, and a fresh code on login) instead of having to re-register.
- Indexes added for sessions, notifications, game sessions, scheduled messages and code tables; the support-message charset conversion is a real migration instead of a boot-time `ALTER`.
- Maintenance scripts under `scripts/` default to dry-run and require `--apply`. Removed the `crypto`, `path` and `querystring` npm packages that shadow Node built-ins; `package-lock.json` is no longer gitignored.

## 2.1.0

### Upgrading from 2.0.0

Read these before deploying.

- **The shared `apiKey` is gone.** Every caller of the API — each Minecraft server, the uptime monitor, and this app itself — now needs its own client key. Create them at **Dashboard → API Keys** (`zander.web.apikeys`); keys look like `zdr_<prefix>_<secret>`. A request carrying the old shared key is rejected with 401.
- **New environment variables:**
  - `INTERNAL_API_KEY` (**required**) — this app's own client key, used for its calls to its own API. Create a client for it at Dashboard → API Keys.
  - `MINEMONITOR_BASE_URL`, `MINEMONITOR_CONNECTION_TOKEN` — see the content filtering note below, and `.env.example`.
- **Content filtering has moved to MineMonitor.** The local `filter.json` word and link lists are gone; the link and phrase filters now ask MineMonitor, which filters through Purify. **If MineMonitor is not configured, or does not answer, content is let through unfiltered.** Set the two `MINEMONITOR_*` variables (or the base URL at Dashboard → Settings → Automation) before deploying if you rely on the filter.
- **Site settings and module switches now live in the database.** `config.json` and `features.json` are no longer read at runtime. On the first boot that finds them, they are imported once into the database. After that, edit settings at **Dashboard → Settings** and switch modules on and off at **Dashboard → Modules**. You can then delete the files.
- **25 database migrations** (`0041`–`0066`) run on deploy via `npm run build`. Migration `0066` cancels leftover duplicate event announcements (see Fixed); nothing is deleted.
- **Node.js 20 or newer** is required.
- **Plugins:** built for Java 21. The Waterfall proxy plugin has been removed; use Velocity.

### New

- **Forms** — build application and survey forms with section breaks, field requirements, eligibility rules, drafts, reapply cooldowns, access codes and optional review. Submissions can open a support ticket or post to a Discord forum thread or DM, and can be exported to CSV. Forms can be duplicated.
- **Webstore** — product and category management, with per-item visibility and settings.
- **Site settings and Modules dashboards** — edit site configuration and turn features on or off without touching files.
- **API Keys dashboard** — issue, scope and revoke a separate key for each API client.
- **Default event announcements** — set Discord, MOTD, in-game tip and website announcements once (Events → Templates → Default Announcements). New events and templates start with them, and **Apply to Existing Events** adds them to upcoming events that don't have them yet.
- **Rank-locked events** — limit an event to certain ranks, with a teaser description shown to everyone else.
- **Discord booster rewards** — give ranks to members who boost the Discord server, and remove them when the boost ends.
- **Rank permissions management** in the dashboard, plus self-promotion rules for rank assignment.
- **Bedrock Edition** landing page and connection details.
- **User profiles** — timezone and birthday.
- **Region settings** — the site's region, country and language, used across the site.
- **Dismissible site-wide banner**; announcements now record when they were created.
- **Verification reminders** for unverified Discord members.
- **Content filtering through MineMonitor** (backed by Purify), including Discord invite-link handling.
- **Latest forum posts on the homepage** — the newest discussions visitors can see, with an excerpt. Show one category (for example network announcements) or all of them, and set how many, at Dashboard → Settings → Watch, Events & Forums.
- **Version and commit** shown in the site and dashboard footers.

### Improved

- **Event announcements move with the event.** Changing an event's date or time reschedules its announcements, on drafts too, and the event page shows when each one will go out.
- **Event templates** pre-fill the new-event form, and the editors give clearer errors.
- **Discord timestamps** in event descriptions render on the site the same way they do in Discord.
- **Locked forum categories** explain what's needed to get access.
- **Event banners** keep their natural aspect ratio on every screen size.
- **Discord role sync** reports what it did and why it failed, and matches users by LuckPerms UUID first, so placeholder accounts no longer get the wrong roles.
- **Discord account linking** resolves conflicts and merges accounts instead of blocking.
- **Sessions** are cached in memory, so most requests no longer read the session from the database.
- **Finance budgets** — entries can be removed from a given month onwards.

### Fixed

- **Event announcements:**
  - Draft events could post their announcements to Discord.
  - Cancelled and deleted events kept announcing: queued Discord messages still went out and MOTDs and banners stayed up.
  - Saving a published event duplicated its announcements.
  - Announcement tokens such as `{discord_f}` and `{endAt}` were posted as raw text.
  - A 0-minute "before event" announcement never sent.
  - Announcements due while the bot was offline were marked failed instead of being retried.
  - Duplicating an event lost its announcements.
  - Editors without reviewer rights could change the announcements of approved and published events.
- **Long report reasons** are trimmed to fit instead of failing to save.
- **Auth utility pages** (password reset and similar) are kept out of search engines.

### Security

- **Content Security Policy**, in report-only mode, with a reporting endpoint.
- **Event descriptions** are sanitised against XSS.
- **Verification and reset codes** are generated with a cryptographic random source.
- **Webhook events** are claimed atomically, so a replayed Stripe event can't be processed twice.
- **Webstore commands** are escaped before being sent to a server.
- **Dependencies** — all known high-severity advisories resolved (`npm audit` is clean).

### Removed

- **Unused files:** about 15 MB of assets (an old admin theme and its fonts and scripts), dead views, and five unused npm packages.
- **`nodemon`** — `npm run dev` now uses Node's built-in `--watch`.
- **The Waterfall plugin.**
