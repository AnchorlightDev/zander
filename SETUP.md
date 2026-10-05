# Local Environment Setup

This document explains how to set up a local environment for this project.

## Prerequisites

- Node.js (v20 or higher)
- npm
- A MySQL database

## Database Setup

1. Create a new MySQL database and set `DATABASE_URL` in `.env` to point at it.
2. Run `npm run build` (or `npx prisma migrate deploy && npx prisma generate`). Prisma creates the schema and applies every migration in `prisma/migrations/` in order.

Schema changes are made by adding a new migration under `prisma/migrations/` — see `CLAUDE.md`. `dbinit.sql` and the `migration/` directory are the pre-Prisma setup scripts, kept for reference only; do not run them on a new database.

## Environment Variables

1. Create a `.env` file in the root of the project.
2. Copy the contents of `.env.example` to the `.env` file.
3. Fill in the required environment variables:
    - `sessionCookieSecret`: A random string of at least 32 characters.
    - `siteAddress`: The URL of the website (e.g., `http://localhost:3000`).
    - `discordAPIKey`: Your Discord bot token.
    - `discordGuildID`: The ID of your Discord server.
    - `tebexSecretKey`: Your Tebex secret key (optional).
    - `mailtrapUsername`: Your Mailtrap username (optional).
    - `mailtrapPassword`: Your Mailtrap password (optional).
    - `mailtrapEndpoint`: Your Mailtrap endpoint (optional).
    - `IMGUR_CLIENT_ID`: Your Imgur client ID.
    - `IMGUR_CLIENT_SECRET`: Your Imgur client secret.
    - `IMGUR_REFRESH_TOKEN`: Your Imgur refresh token.
    - `SUPPORT_CHANNEL_ID`: The ID of the Discord channel where the support message will be posted.
    - `SUPPORT_NOTIFICATION_CHANNEL_ID`: The ID of the Discord channel where new ticket notifications will be sent.
    - `SUPPORT_CATEGORY_ID`: The ID of the Discord category where new ticket channels will be created.
    - `DISCORD_GUILD_ID`: The ID of your Discord server.

## Running the Application

1. Run `npm install` to install the dependencies.
2. Run `npm run dev` to start the application in development mode.
