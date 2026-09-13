# zander-web
The web component of the Zander project that contains database, API and website.

Documentation: [https://modularsoft.org/docs/products/zander](https://modularsoft.org/docs/products/zander)

This repo is a monorepo with two projects:

- **/** (root) — the Node.js web dashboard, API, and database (this document covers it)
- **[agent/](agent/)** — the Java/Maven Minecraft plugins (`zander-addon`, `zander-auth`, `zander-hub`, `zander-velocity`, `zander-waterfall`) (see [agent/README.md](agent/README.md))

## Permissions

All permission nodes follow dot-notation and are managed via LuckPerms. Wildcard support is available (e.g. `zander.web.*` grants all `zander.web.X` nodes). The special `*` node grants full access.

### Web Dashboard

| Permission Node | Description |
|---|---|
| `zander.web.dashboard` | Access the main dashboard |
| `zander.web.logs` | View system logs and audit trails |
| `zander.web.announcements` | Create, edit, and view announcements |
| `zander.web.application` | Manage player applications |
| `zander.web.server` | Manage game servers |
| `zander.web.rank` | Manage individual player ranks via the API |
| `zander.web.ranks` | Access the ranks dashboard page |
| `zander.web.scheduler` | Schedule announcements/messages |
| `zander.web.vault` | Access vault management |
| `zander.web.bridge` | Manage bridge/integrations |
| `zander.web.badges` | Access the badge management dashboard (create, edit, assign, delete badges) |
| `zander.web.apikeys` | Issue, scope and revoke API client credentials |

### Events

| Permission Node | Description |
|---|---|
| `zander.web.events` | Access the events dashboard (view only) |
| `zander.web.events.edit` | Create and edit events |
| `zander.web.events.review` | Review and publish events (implies edit access) |

### Webstore

| Permission Node | Description |
|---|---|
| `zander.web.webstore` | Access the webstore admin dashboard (purchases, command configuration) |

### Finance

| Permission Node | Description |
|---|---|
| `zander.web.finance` | View the finance dashboard (accounts, transactions, categories) |
| `zander.web.finance.manage` | Create, edit, and delete finance records |
| `zander.web.finance.*` | Equivalent to both `zander.web.finance` and `zander.web.finance.manage` |

### Support Tickets

| Permission Node | Description |
|---|---|
| `zander.web.ticket` | Access the support ticket dashboard |
| `zander.web.tickets` | Access ticket category listings |
| `zander.web.tickets.{slug}` | Access a specific ticket category (dynamic, based on category slug) |
| `zander.web.tickets.*` | Access all ticket categories |
| `zander.web.ticket.escalate` | Escalate and de-escalate support tickets |
| `zander.web.tickets.manageparticipants` | Add and remove participants on support tickets |

### Punishments & Moderation

| Permission Node | Description |
|---|---|
| `zander.web.punishment.view` | View the global punishments list |
| `zander.web.punishment.manage` | Manage (edit/delete) punishments |
| `zander.web.punishments` | View punishments on user profiles |
| `zander.web.web-punishments` | Access the web-based punishment dashboard |
| `zander.web.audit` | View user audit entries on profiles |
| `zander.web.reports` | View player reports on profiles |

### Voting

| Permission Node | Description |
|---|---|
| `zander.web.voting` | Access the voting site management dashboard |

### Forums

| Permission Node | Description |
|---|---|
| `zander.web.forums` | Access the forums management dashboard |
| `zander.forums.moderate` | General forum moderation rights |
| `zander.forums.view` | View forum content |
| `zander.forums.post.delete` | Delete forum posts |
| `zander.forums.viewArchived` | View archived forum discussions |
| `zander.forums.discussion.sticky` | Sticky forum discussions |
| `zander.forums.discussion.lock` | Lock forum discussions |
| `zander.forums.discussion.archive` | Archive forum discussions |
| `zander.forums.category.manage` | Manage forum categories (admin dashboard) |

### Discord Punishments

| Permission Node | Description |
|---|---|
| `zander.discord.punish.warn` | Issue warnings to users via Discord |
| `zander.discord.punish.kick` | Kick users from the Discord server |
| `zander.discord.punish.ban` | Ban/unban users from the Discord server |
| `zander.discord.punish.mute` | Mute/unmute users in Discord |
| `zander.discord.punish.history` | View punishment history for users |

### Watch / Creator Content

| Permission Node | Description |
|---|---|
| `zander.watch.creator` | Marks the user as an eligible creator — their linked Twitch/YouTube content is synced to the `/watch` page |

---


## API client credentials

Every caller of the JSON API — each Minecraft server plugin, the uptime monitor,
and this app's own internal self-calls — authenticates with its own credential
rather than a single shared secret. A compromised or retired caller is revoked
on its own, without touching any other.

### Issuing a key

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

### Scopes

One scope per API surface, with **no wildcard** — granting broad access has to
be a deliberate act of selecting every box:

`announcement`, `application`, `badges`, `bridge`, `config`, `discord`,
`events`, `filter`, `finance`, `punishments`, `ranks`, `report`, `scheduler`,
`server`, `session`, `shopdirectory`, `user`, `vault`, `web`, `adminUsers`,
`internal`

A request to a path with no scope mapping is rejected, so a newly added route
is unreachable until it is deliberately given a scope.

### Responses

| Situation | Status |
|---|---|
| Missing or malformed key | `401` |
| Unknown prefix, wrong secret, or revoked client | `401` |
| Valid key without the required scope | `403` |
| Client lookup failed (database unreachable) | `503` |

The body keeps the usual `{ success, message }` shape.

### This app's own calls

The app calls its own API in a number of places (`api/internal_redirect/*`,
several dashboard routes and Discord commands). It uses a dedicated client —
conventionally named `zander-web-internal` — supplied via `INTERNAL_API_KEY`
and applied through `internalApiHeaders()` in `api/common.js`. Never reintroduce
a shared key that the app both presents and validates.

### Revocation

Revoking is a soft delete: the row is kept for audit with `isRevoked` and
`revokedAt` set, and the auth cache entry is evicted immediately so the key
stops working straight away.

## Creator Content Integration (Twitch & YouTube)

The `/watch` page displays live streams and recent videos from community members who have linked their Twitch or YouTube accounts and hold the `zander.watch.creator` permission node. Content is only surfaced if it contains a CFC marker (e.g. `#cfc` in a stream title/tag or video tag/description).

### How it works

1. A user connects their Twitch and/or YouTube account via **Profile → Connected Accounts**.
2. A server admin grants the user the `zander.watch.creator` LuckPerms node.
3. The cron jobs sync the creator's content every 5 minutes (Twitch) or 15 minutes (YouTube).
4. Matching content is cached in the database and shown on `/watch`.
5. A one-time Discord notification is posted to the configured webhook when a creator goes live or uploads an eligible video.

### Setting up Twitch OAuth

1. Go to [https://dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) and create a new application.
2. Set the **OAuth Redirect URL** to `https://<your-domain>/profile/social/twitch/callback`.
3. Copy the **Client ID** and generate a **Client Secret**.
4. Add the following to your `.env`:

```env
twitchClientId=YOUR_CLIENT_ID
twitchClientSecret=YOUR_CLIENT_SECRET
```

### Setting up YouTube OAuth & API Key

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com) and create (or select) a project.
2. Enable the **YouTube Data API v3** under *APIs & Services → Library*.
3. Create an **OAuth 2.0 Client ID** (*APIs & Services → Credentials → Create Credentials*):
   - Application type: **Web application**
   - Authorised redirect URI: `https://<your-domain>/profile/social/youtube/callback`
   - When the OAuth consent screen asks for scopes, add **`https://www.googleapis.com/auth/youtube.readonly`** — this grants read-only access to the user's YouTube channel identity and is the only scope requested during the account-linking flow.
4. Create an **API Key** (*Create Credentials → API Key*) and restrict it to the YouTube Data API v3. This key is used server-side by the sync cron job to read public channel content without requiring a user token.
5. Add the following to your `.env`:

```env
googleClientId=YOUR_OAUTH_CLIENT_ID
googleClientSecret=YOUR_OAUTH_CLIENT_SECRET
youtubeApiKey=YOUR_API_KEY
```

> **Scope note:** The OAuth flow requests `https://www.googleapis.com/auth/youtube.readonly` with `access_type=offline` so that a refresh token is issued. The server only uses this token to identify the user's channel (channel ID, display name, avatar). All subsequent content syncing is done using the server-side API key against public channel data, so no ongoing access to the user's account is required after the initial link.

### Configuring CFC content filters

The filters that determine whether content is CFC-related are configured in `config.json` under the `watch.filters` key:

```json
"watch": {
  "contentChannelWebhook": "https://discord.com/api/webhooks/...",
  "contentPingRoleId": null,
  "filters": {
    "twitch": {
      "titleMarkers": ["#cfc", "[cfc]"],
      "tags": ["cfc"]
    },
    "youtube": {
      "tags": ["cfc"],
      "descriptionMarkers": ["#cfc"]
    }
  }
}
```

| Field | Description |
|---|---|
| `contentChannelWebhook` | Discord webhook URL to post live/upload notifications to |
| `contentPingRoleId` | Role ID to ping in notifications, or `null` to disable pinging |
| `filters.twitch.titleMarkers` | Stream title substrings that qualify content (case-insensitive) |
| `filters.twitch.tags` | Twitch stream tags that qualify content (exact match, case-insensitive) |
| `filters.youtube.tags` | YouTube video tags that qualify content (exact match, case-insensitive) |
| `filters.youtube.descriptionMarkers` | Video description substrings that qualify content (case-insensitive) |

### Feature flag

The `/watch` route is controlled by the `watch` key in `features.json`. Set it to `false` to disable the page entirely:

```json
{
  "watch": false
}
```

### Database migration

Run `migration/v1.11.0_v1.12.0.sql` against your database to create the four tables required by this feature:

| Table | Purpose |
|---|---|
| `user_platform_connections` | Stores OAuth tokens and channel identity for each linked Twitch/YouTube account |
| `creator_watch_settings` | Per-user toggles controlling listing visibility and Discord notification preferences |
| `creator_content_items` | Cached CFC-eligible content items fetched by the cron jobs |
| `creator_content_notifications` | Deduplication log preventing repeat Discord notifications for the same content |

---

## Webstore

The `/webstore` module is a Stripe-powered store for selling in-game ranks and perks. It supports one-time purchases, recurring subscriptions, and gifting to other players. Rank grants are delivered as console commands via the `executorTasks` table (picked up by zander-addon), so the recipient does not need to be online.

### Feature flag

The webstore is controlled by the `webstore` key in `features.json`. Set it to `false` to disable the storefront and all checkout routes:

```json
{
  "webstore": true
}
```

The `/give` (support the server) page is always available — it does not check the webstore feature flag.

### Environment variables

Add the following to your `.env`:

```env
# Stripe secret key — obtain from https://dashboard.stripe.com/apikeys
STRIPE_SECRET_KEY=sk_live_...

# Stripe webhook signing secret — from the webhook endpoint settings in your Stripe dashboard
STRIPE_WEBHOOK_SECRET=whsec_...

# Monthly server cost goal in cents (e.g. 5000 = $50.00) — shown on the /give page
WEBSTORE_MONTHLY_GOAL_CENTS=5000
```

### Stripe webhook setup

1. In the [Stripe dashboard](https://dashboard.stripe.com/webhooks), create a new webhook endpoint pointing to `https://<your-domain>/api/internal/stripe-webhook`.
2. Enable the following events:
   - `checkout.session.completed`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
3. Copy the **Signing secret** and set it as `STRIPE_WEBHOOK_SECRET` in your `.env`.

### Adding products

Products are pulled directly from Stripe. For each rank or perk:

1. Create a **Product** and one or more **Prices** in the Stripe dashboard.
   - Use a recurring price for subscription ranks; a one-time price for permanent ranks.
2. Set the following **metadata** on the Stripe **Product**:
   - `slug` — a short identifier used internally (e.g. `vip`, `mvp`). Must be unique.
   - `description` *(optional)* — short description shown on the store card.
3. Insert a row into `webstoreStripeCommands` for each command that should run when the price is purchased:

```sql
INSERT INTO webstoreStripeCommands (stripePriceId, action, commandTemplate, sortOrder)
VALUES
  ('price_xxx', 'grant', 'lp user {{ username }} parent add vip', 1),
  ('price_xxx', 'grant', 'lp user {{ username }} meta set prefix "&6[VIP]"', 2);
```

For subscription ranks, also add a matching `revoke` command that fires when the subscription is cancelled:

```sql
INSERT INTO webstoreStripeCommands (stripePriceId, action, commandTemplate, sortOrder)
VALUES
  ('price_xxx', 'revoke', 'lp user {{ username }} parent remove vip', 1);
```

#### Command template placeholders

| Placeholder | Replaced with |
|---|---|
| `{{ username }}` | Recipient's Minecraft username |
| `{{ purchaserUsername }}` | Purchaser's Minecraft username (differs from `username` when gifted) |
| `{{ purchaseId }}` | Internal purchase ID |
| `{{ itemSlug }}` | Stripe product slug metadata value |
| `{{ purchaseType }}` | `one_time` or `subscription` |
| `{{ isGift }}` | `true` or `false` |

### Subscription lifecycle

| Stripe event | Action taken |
|---|---|
| `checkout.session.completed` | Purchase record created and fulfilled; subscription record created; `grant` commands enqueued |
| `invoice.payment_succeeded` (renewal) | Subscription period updated; `grant` commands re-enqueued for the new period |
| `invoice.payment_failed` | Subscription marked `past_due`; no rank change (Stripe retries) |
| `customer.subscription.updated` | Local subscription status synced to Stripe status |
| `customer.subscription.deleted` | Subscription marked `cancelled`; `revoke` commands enqueued |

### Discord notifications

The webstore posts to a Discord webhook on key events. Configure the webhook URL in `config.json` under `siteConfiguration.staffWebhook` (shared with other staff notifications).

### Database migration

Run `prisma/migrations/0017_webstore/migration.sql` against your database (or run `prisma migrate deploy` if using Prisma Migrate):

| Table | Purpose |
|---|---|
| `webstorePurchases` | One row per Stripe checkout session; tracks status from `pending` through `fulfilled` |
| `webstoreSubscriptions` | Tracks the full lifecycle of every active subscription (period, status, cancellation) |
| `webstoreWebhookEvents` | Idempotency log — prevents duplicate processing if Stripe delivers the same event twice |
| `webstoreStripeCommands` | Maps Stripe price IDs to in-game command templates, with `grant`/`revoke` action distinction |
| `webstoreCommandRuns` | Tracks each individual command dispatched to `executorTasks` and its completion status |
| `webstoreTransactions` | Audit ledger recording the financial side of every completed payment |

