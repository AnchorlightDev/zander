# Webstore

The `/webstore` module is a Stripe-powered store for selling in-game ranks and perks. It supports one-time purchases, recurring subscriptions, and gifting to other players. Rank grants are delivered as console commands via the `executorTasks` table (picked up by zander-addon), so the recipient does not need to be online.

## Feature flag

The webstore is controlled by the **Webstore** switch in **Dashboard → Modules** (`features.webstore`). Turn it off to disable the storefront and all checkout routes:

```json
{
  "webstore": true
}
```

The `/give` (support the server) page is always available — it does not check the webstore feature flag.

## Environment variables

Add the following to your `.env`:

```env
# Stripe secret key — obtain from https://dashboard.stripe.com/apikeys
STRIPE_SECRET_KEY=sk_live_...

# Stripe webhook signing secret — from the webhook endpoint settings in your Stripe dashboard
STRIPE_WEBHOOK_SECRET=whsec_...

# Monthly server cost goal in cents (e.g. 5000 = $50.00) — shown on the /give page
WEBSTORE_MONTHLY_GOAL_CENTS=5000
```

## Stripe webhook setup

1. In the [Stripe dashboard](https://dashboard.stripe.com/webhooks), create a new webhook endpoint pointing to `https://<your-domain>/api/internal/stripe-webhook`.
2. Enable the following events:
   - `checkout.session.completed`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
3. Copy the **Signing secret** and set it as `STRIPE_WEBHOOK_SECRET` in your `.env`.

## Adding products

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

### Command template placeholders

| Placeholder | Replaced with |
|---|---|
| `{{ username }}` | Recipient's Minecraft username |
| `{{ purchaserUsername }}` | Purchaser's Minecraft username (differs from `username` when gifted) |
| `{{ purchaseId }}` | Internal purchase ID |
| `{{ itemSlug }}` | Stripe product slug metadata value |
| `{{ purchaseType }}` | `one_time` or `subscription` |
| `{{ isGift }}` | `true` or `false` |

## Subscription lifecycle

| Stripe event | Action taken |
|---|---|
| `checkout.session.completed` | Purchase record created and fulfilled; subscription record created; `grant` commands enqueued |
| `invoice.payment_succeeded` (renewal) | Subscription period updated; `grant` commands re-enqueued for the new period |
| `invoice.payment_failed` | Subscription marked `past_due`; no rank change (Stripe retries) |
| `customer.subscription.updated` | Local subscription status synced to Stripe status |
| `customer.subscription.deleted` | Subscription marked `cancelled`; `revoke` commands enqueued |

## Discord notifications

The webstore posts to a Discord webhook on key events. Set the webhook in **Dashboard → Settings → Discord** (*Webstore webhook*).

## Database migration

Run `prisma/migrations/0017_webstore/migration.sql` against your database (or run `prisma migrate deploy` if using Prisma Migrate):

| Table | Purpose |
|---|---|
| `webstorePurchases` | One row per Stripe checkout session; tracks status from `pending` through `fulfilled` |
| `webstoreSubscriptions` | Tracks the full lifecycle of every active subscription (period, status, cancellation) |
| `webstoreWebhookEvents` | Idempotency log — prevents duplicate processing if Stripe delivers the same event twice |
| `webstoreStripeCommands` | Maps Stripe price IDs to in-game command templates, with `grant`/`revoke` action distinction |
| `webstoreCommandRuns` | Tracks each individual command dispatched to `executorTasks` and its completion status |
| `webstoreTransactions` | Audit ledger recording the financial side of every completed payment |


---
