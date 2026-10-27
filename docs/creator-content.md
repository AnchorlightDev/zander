# Creator content (Twitch & YouTube)

The `/watch` page displays live streams and recent videos from community members who have linked their Twitch or YouTube accounts and hold the `zander.watch.creator` permission node. Content is only surfaced if it contains a CFC marker (e.g. `#cfc` in a stream title/tag or video tag/description).

## How it works

1. A user connects their Twitch and/or YouTube account via **Profile → Connected Accounts**.
2. A server admin grants the user the `zander.watch.creator` LuckPerms node.
3. The cron jobs sync the creator's content every 5 minutes (Twitch) or 15 minutes (YouTube).
4. Matching content is cached in the database and shown on `/watch`.
5. A one-time Discord notification is posted to the configured webhook when a creator goes live or uploads an eligible video.

## Setting up Twitch OAuth

1. Go to [https://dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) and create a new application.
2. Set the **OAuth Redirect URL** to `https://<your-domain>/profile/social/twitch/callback`.
3. Copy the **Client ID** and generate a **Client Secret**.
4. Add the following to your `.env`:

```env
twitchClientId=YOUR_CLIENT_ID
twitchClientSecret=YOUR_CLIENT_SECRET
```

## Setting up YouTube OAuth & API Key

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

## Configuring CFC content filters

The filters that determine whether content is CFC-related are set in **Dashboard → Settings → Watch & Events** (stored as `watch.filters`):

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

## Feature flag

The `/watch` route is controlled by the **Watch** switch in **Dashboard → Modules** (`features.watch`). Turn it off to disable the page entirely:

```json
{
  "watch": false
}
```

## Database migration

The Prisma migrations (`npm run build`) create the four tables this feature uses:

| Table | Purpose |
|---|---|
| `user_platform_connections` | Stores OAuth tokens and channel identity for each linked Twitch/YouTube account |
| `creator_watch_settings` | Per-user toggles controlling listing visibility and Discord notification preferences |
| `creator_content_items` | Cached CFC-eligible content items fetched by the cron jobs |
| `creator_content_notifications` | Deduplication log preventing repeat Discord notifications for the same content |

---
