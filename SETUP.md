# Local Environment Setup

This document explains how to set up a local environment for this project.

## Prerequisites

- Node.js (v20 or higher)
- npm
- A MySQL database

## Database Setup

1. Create a new MySQL database and set `DATABASE_URL` in `.env` to point at it.
2. Run `npm run build` (or `npx prisma migrate deploy && npx prisma generate`). Prisma creates the schema and applies every migration in `prisma/migrations/` in order.

Schema changes are made by adding a new migration under `prisma/migrations/` — see `CLAUDE.md`.

## Environment Variables

1. Create a `.env` file in the root of the project.
2. Copy the contents of `.env.example` to the `.env` file.
3. Fill in the required environment variables:
    - `sessionCookieSecret`: A random string of at least 32 characters (`openssl rand -hex 32`). The app will not start with the placeholder from `.env.example`.
    - `TRUST_PROXY_HOPS`: Leave unset. On an https deployment the app trusts the platform proxy automatically; a numeric value can break logins (see `.env.example`).
    - `siteAddress`: The URL of the website (e.g., `http://localhost:3000`).
    - `DATABASE_URL`: The Zander database. `LUCKPERMS_URL`, `QUICKSHOP_URL` and `PUNISHMENTS_URL` point at the LuckPerms, QuickShop and LiteBans databases.
    - `discordAPIKey`, `discordClientId`, `discordClientSecret`: Your Discord bot token and OAuth application.
    - `INTERNAL_API_KEY`: This app's own API key. Create it at **Dashboard → API Keys** after first sign-in, then restart.
    - Optional integrations: SMTP (`smtp*`) for email, Stripe (`STRIPE_*`) for the webstore, Twitch/YouTube (`twitch*`, `google*`, `youtubeApiKey`) for creator content, Cloudinary for uploads, web push (`VAPID_*`), Sentry (`SENTRY_DSN`), MineMonitor (`MINEMONITOR_*`) for content filtering, and `OIDC_*` for Compass sign-in. `.env.example` describes each one.

    Discord channel IDs, the guild ID and other site settings are no longer environment variables: set them at **Dashboard → Settings** once you can sign in.

## Running the Application

1. Run `npm install` to install the dependencies.
2. Run `npm run dev` to start the application in development mode.
