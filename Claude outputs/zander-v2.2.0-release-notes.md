Zander 2.2.0 brings custom pages and menus, in-game holograms you design from the dashboard, guest support tickets, Compass sign-in for staff, and a smarter shop directory, along with a large round of security hardening.

> **Read [Before you upgrade](#before-you-upgrade) first.** Two settings decide whether the site starts and whether people can sign in.

## Highlights

**Holograms from the dashboard.** Design text holograms on the website, with optional countdowns and expiry times, then place them anywhere with `/hologram create <name> <group>`. Edits show up in-game without a restart.

**Custom pages and menus.** Publish your own site pages and edit the top bar, header and footer navigation straight from the dashboard.

**Shop directory finds enchantments.** Search `/shopdirectory sharpness` or `fire protection` and get results like *Enchanted Book (Sharpness V)*. Potions, firework rockets and shulker box contents are labelled too.

**Support without an account.** Anyone can open a ticket from the new contact form and follow the conversation through a private emailed link. Staff get a ticket queue overview.

**Resources library.** Members suggest useful links and staff vote on which ones get published.

**Live streams in-game.** When a creator goes live, an in-game tip announces it, and it disappears when the stream ends.

**Compass sign-in.** Zander is now an OpenID Connect provider, so staff sign in to the Compass staff portal with their CFC account.

**Report Message in Discord.** Right-click any message → Apps → **Report Message**.

Also new: scheduled Discord embeds can be edited after they are created, the account pages (registration, verification, password reset, Minecraft linking) have been redesigned, punishment settings apply without a restart, and Discord background jobs no longer trip Discord's rate limits.

## Security

This release closes a long list of issues found in a security review, including:

- Account takeover through registration over an existing linked account.
- A path traversal reaching internal API endpoints.
- Client-controlled IP spoofing in rate limiting.
- Cross-site request protection on all cookie-authenticated writes.
- Upload limits and type checks that are actually enforced.
- Tighter rich-text sanitising.
- All `npm audit` advisories, including two high-severity ones.

The full list is in the [changelog](https://github.com/AnchorlightDev/zander/blob/master/CHANGELOG.md#security).

## Before you upgrade

1. **Session secret:** `sessionCookieSecret` must be at least 32 characters. The app refuses to start with a short value or the example one. Generate one with `openssl rand -hex 32`.
2. **Proxy hops:** leave `TRUST_PROXY_HOPS` **unset** on an https host such as Render, and the app trusts the platform proxy automatically. Do not set it to `1` (the 2.2.0 `.env.example` wrongly does): a numeric value can stop the session cookie being set and break every login.
3. **Hologram API scope:** each game server's API key needs the `hologram` scope. Keys can't be edited, so create a new key with `bridge` and `hologram` at **Dashboard → API Keys**, put it in the addon's `config.yml`, revoke the old key, then update `zander-addon` on every game server.
4. **Ticket category staff:** grant `zander.web.tickets.manage` to staff who manage ticket categories. The view node no longer allows renaming or deleting categories.
5. **Compass only:** set the `OIDC_*` variables listed in `.env.example`.
6. **Optional modules:** Resources and the Contact form start switched off. Turn them on under **Dashboard → Modules**.

**Database and runtime:** 10 migrations (`0067`–`0076`) run automatically with `npm run build`. Nothing is dropped. Node.js 22 is recommended (pinned in `.node-version`).

**Removed:** the email error alerts (`adminErrorEmail`), the Discord staff audit log webhook setting, and the legacy `migration/*.sql` and `dbinit.sql` files. Prisma migrations are now the only upgrade path.

New permission nodes: `zander.web.pages`, `zander.web.menus`, `zander.web.resources`, `zander.web.resources.review`, `zander.web.holograms`, `zander.web.tickets.manage`. See the [permission reference](https://github.com/AnchorlightDev/zander/blob/master/docs/permissions.md).

## Plugins

Build with `cd agent && mvn`. The jars land in `agent/target/plugins/`:

| Jar | Install on |
|---|---|
| `zander-velocity-2.2.0.jar` | Velocity proxy |
| `zander-hub-2.2.0.jar` | Hub server |
| `zander-addon-2.2.0.jar` | Every game server (**required for holograms**) |
| `zander-auth-2.2.0.jar` | Every game server |

---

**Full changelog:** [CHANGELOG.md](https://github.com/AnchorlightDev/zander/blob/master/CHANGELOG.md) · **Compare:** [`2.1.0...2.2.0`](https://github.com/AnchorlightDev/zander/compare/2.1.0...2.2.0)
