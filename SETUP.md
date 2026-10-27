# Setting up Zander

The setup guide lives on the documentation site:

- **[Installation](https://anchorlight.dev/docs/products/zander/installation)** — prerequisites, `.env`, database and first run
- **[Configuration](https://anchorlight.dev/docs/products/zander/configuration)** — environment variables, Dashboard → Settings and Modules
- **[Setup guide](https://anchorlight.dev/docs/products/zander/admin/setup)** — the full walkthrough, including the Discord bot and API keys
- **[Upgrading to 2.2.0](https://anchorlight.dev/docs/products/zander/upgrading)**

Quick start for local development:

```bash
cp .env.example .env   # fill in DATABASE_URL, sessionCookieSecret, Discord keys
npm run build          # install, run migrations, generate the Prisma client
npm run dev            # http://localhost:3000
```
