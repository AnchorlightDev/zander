/**
 * webstoreController.js
 *
 * All database and business logic for the Webstore module.
 *
 * Fulfillment uses the executorTasks system so LuckPerms/console commands run
 * on the Minecraft server regardless of whether the player is online at the
 * time of purchase.
 *
 * Tables used:
 *   webstorePurchases       — one row per Stripe checkout session / order
 *   webstoreSubscriptions   — active subscription lifecycle tracking
 *   webstoreWebhookEvents   — idempotency log for Stripe webhook events
 *   webstoreStripeCommands  — maps Stripe price IDs to commands (Minecraft or Discord role)
 *   webstoreCommandRuns     — individual command execution records
 *   webstoreTransactions    — audit ledger for all completed payments
 *
 * Command templates support the following placeholders:
 *   {{ username }}          — recipient Minecraft username
 *   {{ purchaserUsername }} — purchaser Minecraft username
 *   {{ purchaseId }}        — internal purchase ID (for auditing)
 *   {{ itemSlug }}          — Stripe price ID / item slug
 *   {{ purchaseType }}      — 'one_time' or 'subscription'
 *   {{ isGift }}            — 'true' or 'false'
 */

import db from "./databaseController.js";
import fetch from "node-fetch";

// ---------------------------------------------------------------------------
// Internal DB helper
// ---------------------------------------------------------------------------

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      return resolve(results);
    });
  });
}

// ---------------------------------------------------------------------------
// Stripe API helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all active Stripe prices with expanded product data.
 * Uses cursor pagination to handle large catalogs.
 */
export async function fetchStripePrices() {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) throw new Error("STRIPE_SECRET_KEY is not configured");

  const prices = [];
  let startingAfter = null;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({ limit: "100", active: "true" });
    params.append("expand[]", "data.product");
    if (startingAfter) params.append("starting_after", startingAfter);

    const response = await fetch(`https://api.stripe.com/v1/prices?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Stripe API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    prices.push(...(data.data || []));
    hasMore = Boolean(data.has_more);
    startingAfter = data.data?.length ? data.data[data.data.length - 1].id : null;
  }

  return prices;
}

/**
 * Resolve the best price amount for a requested currency, falling back to the
 * price's default currency when the preferred one is not available.
 */
export function resolveStripePriceAmount(price, preferredCurrency) {
  if (preferredCurrency) {
    const key = preferredCurrency.toLowerCase();
    const opt = price.currency_options?.[key];
    if (opt?.unit_amount) return { amount: opt.unit_amount, currency: key };
  }
  return { amount: price.unit_amount || 0, currency: price.currency || "usd" };
}

/**
 * Fetch a single Stripe subscription object.
 * Returns null on failure so callers can proceed without period data.
 */
export async function fetchStripeSubscription(subscriptionId) {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey || !subscriptionId) return null;

  try {
    const response = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

/**
 * Create a Stripe Checkout session and return the session object.
 */
export async function createStripeCheckoutSession({
  item,
  userId,
  recipientMinecraftUsername,
  purchaserMinecraftUsername,
  isGift,
}) {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) throw new Error("STRIPE_SECRET_KEY is not configured");

  const mode = item.purchaseType === "subscription" ? "subscription" : "payment";

  const body = new URLSearchParams();
  body.append("mode", mode);
  body.append("line_items[0][price]", item.stripePriceId);
  body.append("line_items[0][quantity]", "1");
  body.append(
    "success_url",
    `${process.env.siteAddress}/webstore/thank-you?session_id={CHECKOUT_SESSION_ID}`
  );
  body.append("cancel_url", `${process.env.siteAddress}/webstore?canceled=1`);
  body.append("client_reference_id", String(userId));
  // Store metadata so the webhook can retrieve context without another API call
  body.append("metadata[itemSlug]", item.slug);
  body.append("metadata[userId]", String(userId));
  body.append("metadata[recipientUsername]", recipientMinecraftUsername);
  body.append("metadata[purchaserUsername]", purchaserMinecraftUsername);
  body.append("metadata[isGift]", isGift ? "true" : "false");

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Stripe checkout session error ${response.status}: ${text}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Locale / currency helpers
// ---------------------------------------------------------------------------

const REGION_TO_CURRENCY = {
  AU: "aud", US: "usd", GB: "gbp", CA: "cad", NZ: "nzd",
  EU: "eur", DE: "eur", FR: "eur", NL: "eur", IT: "eur", ES: "eur",
  AT: "eur", BE: "eur", FI: "eur", GR: "eur", IE: "eur", PT: "eur",
};

export function preferredCurrencyFromLocale(locale) {
  if (!locale) return null;
  const region = locale.split(/[-_]/)[1]?.toUpperCase();
  return region ? (REGION_TO_CURRENCY[region] || null) : null;
}

/**
 * Format an amount in the smallest currency unit (e.g. cents) as a localised
 * currency string.  Handles zero-decimal currencies correctly.
 */
export function formatPrice(priceCents, currency, locale = "en-US") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
    minimumFractionDigits: 2,
  }).format((Number(priceCents) || 0) / 100);
}

/**
 * Interpolate {{ placeholder }} tokens in a command template string.
 * Unknown tokens are left as empty strings.
 */
export function resolveCommandTemplate(template, metadata) {
  if (typeof template !== "string") return "";
  if (!metadata) return template;

  return Object.entries(metadata).reduce((cmd, [key, value]) => {
    const replacement = value === null || value === undefined ? "" : String(value);
    return cmd.replace(new RegExp(`{{\\s*${key}\\s*}}`, "gi"), replacement);
  }, template);
}

// ---------------------------------------------------------------------------
// Product / command catalogue
// ---------------------------------------------------------------------------

/**
 * Return all active Stripe items enriched with their command templates from
 * the webstoreStripeCommands table.  Prices are optionally converted to a
 * preferred currency.
 */
export async function getWebstoreItems(preferredCurrency = null) {
  const prices = await fetchStripePrices();

  const unexpanded = prices.filter((p) => typeof p.product === "string");
  if (unexpanded.length > 0) {
    console.warn(`[webstore] ${unexpanded.length} price(s) have an unexpanded product reference — they will be excluded from the storefront`);
  }

  const items = prices
    .filter((p) => p.active && typeof p.product === "object" && p.product?.active)
    .map((p) => {
      const { amount, currency } = resolveStripePriceAmount(p, preferredCurrency);
      const sortKey =
        typeof p.product?.metadata?.sortOrder === "string"
          ? Number(p.product.metadata.sortOrder) || 0
          : 0;
      return {
        slug: p.id,
        stripePriceId: p.id,
        displayName: p.product?.name || p.nickname || p.id,
        description: p.product?.description || "",
        imageUrl: p.product?.images?.[0] || null,
        priceCents: amount,
        currency,
        purchaseType: p.type === "recurring" || p.recurring ? "subscription" : "one_time",
        sortKey,
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey || a.displayName.localeCompare(b.displayName));

  if (!items.length) return [];

  // Attach command entries from DB — each entry is { commandTemplate, commandType }
  const priceIds = items.map((i) => i.stripePriceId);
  const placeholders = priceIds.map(() => "?").join(",");
  const commands = await query(
    `SELECT stripePriceId, action, commandTemplate, commandType, serverSlug
     FROM webstoreStripeCommands
     WHERE stripePriceId IN (${placeholders})
     ORDER BY action ASC, sortOrder ASC, commandId ASC`,
    priceIds
  );

  const grantByPrice = {};
  const revokeByPrice = {};
  for (const cmd of commands) {
    const entry = { commandTemplate: cmd.commandTemplate, commandType: cmd.commandType || "minecraft", serverSlug: cmd.serverSlug || null };
    if (cmd.action === "revoke") {
      (revokeByPrice[cmd.stripePriceId] = revokeByPrice[cmd.stripePriceId] || []).push(entry);
    } else {
      (grantByPrice[cmd.stripePriceId] = grantByPrice[cmd.stripePriceId] || []).push(entry);
    }
  }

  return items.map((item) => ({
    ...item,
    grantCommands: grantByPrice[item.stripePriceId] || [],
    revokeCommands: revokeByPrice[item.stripePriceId] || [],
  }));
}

/** Find a single webstore item by its slug (= Stripe price ID). */
export async function findWebstoreItem(slug) {
  const items = await getWebstoreItems();
  return items.find((i) => i.slug === slug) || null;
}

/**
 * Fetch grant and revoke command templates for a Stripe price ID directly from
 * the DB (no Stripe API call).  Used during subscription renewal and revocation
 * where only the price ID is known.
 */
export async function getCommandsByPriceId(stripePriceId) {
  const rows = await query(
    `SELECT action, commandTemplate, commandType, serverSlug
     FROM webstoreStripeCommands
     WHERE stripePriceId = ?
     ORDER BY action ASC, sortOrder ASC, commandId ASC`,
    [stripePriceId]
  );
  const toEntry = (r) => ({ commandTemplate: r.commandTemplate, commandType: r.commandType || "minecraft", serverSlug: r.serverSlug || null });
  return {
    grantCommands: rows.filter((r) => r.action === "grant").map(toEntry),
    revokeCommands: rows.filter((r) => r.action === "revoke").map(toEntry),
  };
}

// ---------------------------------------------------------------------------
// Purchase records
// ---------------------------------------------------------------------------

/**
 * Insert a pending purchase record when the user is redirected to Stripe.
 * Returns the new purchaseId.
 */
export async function createPendingPurchase({
  userId,
  item,
  purchaserMinecraftUsername,
  recipientMinecraftUsername,
  stripeSessionId,
  isGift,
}) {
  const result = await query(
    `INSERT INTO webstorePurchases
       (userId, itemSlug, itemName, purchaseType,
        purchaserMinecraftUsername, recipientMinecraftUsername,
        stripeSessionId, amountCents, currency, isGift)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      item.slug,
      item.displayName,
      item.purchaseType,
      purchaserMinecraftUsername,
      recipientMinecraftUsername,
      stripeSessionId,
      item.priceCents,
      item.currency,
      isGift ? 1 : 0,
    ]
  );
  return result.insertId;
}

export async function getPurchaseBySessionId(stripeSessionId) {
  const rows = await query(
    "SELECT * FROM webstorePurchases WHERE stripeSessionId = ? LIMIT 1",
    [stripeSessionId]
  );
  return rows[0] || null;
}

export async function getPurchaseById(purchaseId) {
  const rows = await query(
    "SELECT * FROM webstorePurchases WHERE purchaseId = ? LIMIT 1",
    [purchaseId]
  );
  return rows[0] || null;
}

/**
 * Update Stripe identifiers on a purchase and transition its status.
 */
export async function updatePurchasePayment({
  purchaseId,
  status,
  paymentIntentId,
  subscriptionId,
  customerId,
}) {
  return query(
    `UPDATE webstorePurchases
     SET status = ?, stripePaymentIntentId = ?,
         stripeSubscriptionId = ?, stripeCustomerId = ?, updatedAt = NOW()
     WHERE purchaseId = ?`,
    [status, paymentIntentId || null, subscriptionId || null, customerId || null, purchaseId]
  );
}

export async function updatePurchaseStatus(purchaseId, status) {
  return query(
    "UPDATE webstorePurchases SET status = ?, updatedAt = NOW() WHERE purchaseId = ?",
    [status, purchaseId]
  );
}

/**
 * Return paginated purchase history for a given user, newest first.
 */
export async function getPurchaseHistory(userId, limit = 20, offset = 0) {
  return query(
    `SELECT purchaseId, itemName, purchaseType, recipientMinecraftUsername,
            purchaserMinecraftUsername, amountCents, currency, isGift,
            status, createdAt
     FROM webstorePurchases
     WHERE userId = ?
     ORDER BY createdAt DESC
     LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
}

export async function getPurchaseHistoryCount(userId) {
  const rows = await query(
    "SELECT COUNT(*) AS total FROM webstorePurchases WHERE userId = ?",
    [userId]
  );
  return Number(rows[0]?.total || 0);
}

/**
 * Return paginated gifts received by a Minecraft username from other players,
 * newest first.  Excludes self-purchases (isGift = 1 ensures it's a real gift).
 */
export async function getReceivedGifts(minecraftUsername, limit = 20, offset = 0) {
  return query(
    `SELECT purchaseId, itemName, purchaseType, purchaserMinecraftUsername,
            amountCents, currency, status, createdAt
     FROM webstorePurchases
     WHERE recipientMinecraftUsername = ? AND isGift = 1
     ORDER BY createdAt DESC
     LIMIT ? OFFSET ?`,
    [minecraftUsername, limit, offset]
  );
}

export async function getReceivedGiftsCount(minecraftUsername) {
  const rows = await query(
    "SELECT COUNT(*) AS total FROM webstorePurchases WHERE recipientMinecraftUsername = ? AND isGift = 1",
    [minecraftUsername]
  );
  return Number(rows[0]?.total || 0);
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Create or update a subscription record.  Uses INSERT … ON DUPLICATE KEY
 * UPDATE so it is safe to call on renewal events.
 */
export async function upsertSubscription({
  purchaseId,
  stripeSubscriptionId,
  stripeCustomerId,
  stripePriceId,
  recipientMinecraftUsername,
  purchaserMinecraftUsername,
  purchaserUserId,
  status,
  currentPeriodStart,
  currentPeriodEnd,
  cancelAtPeriodEnd,
}) {
  return query(
    `INSERT INTO webstoreSubscriptions
       (purchaseId, stripeSubscriptionId, stripeCustomerId, stripePriceId,
        recipientMinecraftUsername, purchaserMinecraftUsername, purchaserUserId,
        status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status             = VALUES(status),
       currentPeriodStart = VALUES(currentPeriodStart),
       currentPeriodEnd   = VALUES(currentPeriodEnd),
       cancelAtPeriodEnd  = VALUES(cancelAtPeriodEnd),
       stripeCustomerId   = VALUES(stripeCustomerId),
       updatedAt          = NOW()`,
    [
      purchaseId,
      stripeSubscriptionId,
      stripeCustomerId || null,
      stripePriceId,
      recipientMinecraftUsername,
      purchaserMinecraftUsername,
      purchaserUserId,
      status,
      currentPeriodStart ? new Date(currentPeriodStart * 1000) : null,
      currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
      cancelAtPeriodEnd ? 1 : 0,
    ]
  );
}

export async function getSubscriptionByStripeId(stripeSubscriptionId) {
  const rows = await query(
    "SELECT * FROM webstoreSubscriptions WHERE stripeSubscriptionId = ? LIMIT 1",
    [stripeSubscriptionId]
  );
  return rows[0] || null;
}

export async function updateSubscriptionStatus(stripeSubscriptionId, status, cancelledAt = null) {
  return query(
    `UPDATE webstoreSubscriptions
     SET status = ?, cancelledAt = ?, updatedAt = NOW()
     WHERE stripeSubscriptionId = ?`,
    [status, cancelledAt, stripeSubscriptionId]
  );
}

export async function updateSubscriptionPeriod(stripeSubscriptionId, currentPeriodStart, currentPeriodEnd) {
  return query(
    `UPDATE webstoreSubscriptions
     SET currentPeriodStart = ?, currentPeriodEnd = ?, status = 'active', updatedAt = NOW()
     WHERE stripeSubscriptionId = ?`,
    [
      currentPeriodStart ? new Date(currentPeriodStart * 1000) : null,
      currentPeriodEnd ? new Date(currentPeriodEnd * 1000) : null,
      stripeSubscriptionId,
    ]
  );
}

// ---------------------------------------------------------------------------
// Webhook event idempotency
// ---------------------------------------------------------------------------

/** Returns true if this Stripe event ID has already been processed. */
export async function hasWebhookEvent(stripeEventId) {
  const rows = await query(
    "SELECT webhookEventId FROM webstoreWebhookEvents WHERE stripeEventId = ? LIMIT 1",
    [stripeEventId]
  );
  return rows.length > 0;
}

export async function recordWebhookEvent({ stripeEventId, purchaseId, eventType, payload }) {
  return query(
    `INSERT INTO webstoreWebhookEvents (stripeEventId, purchaseId, eventType, payload)
     VALUES (?, ?, ?, ?)`,
    [stripeEventId, purchaseId || null, eventType, payload ? JSON.stringify(payload) : null]
  );
}

// ---------------------------------------------------------------------------
// Command execution via executorTasks
// ---------------------------------------------------------------------------

/**
 * Enqueue Minecraft console commands via executorTasks.
 * Each entry in `commands` is { commandTemplate, commandType } — only
 * entries with commandType === 'minecraft' are processed here.
 *
 * Returns an array of inserted commandRunIds.
 */
export async function enqueueCommands({
  purchaseId,
  stripeSubscriptionId = null,
  action,
  commands,
  metadata,
  priority = 5,
}) {
  if (!Array.isArray(commands) || !commands.length) return [];

  const minecraftCmds = commands.filter((c) => (c.commandType || "minecraft") === "minecraft");
  const runIds = [];

  for (const cmd of minecraftCmds) {
    const resolvedCommand = resolveCommandTemplate(cmd.commandTemplate, metadata);

    // Insert executor task — picked up by zander-addon and run as a console command.
    // Use the command's configured serverSlug so the right server claims the task.
    const taskSlug = cmd.serverSlug || "any";
    const taskResult = await query(
      `INSERT INTO executorTasks (slug, command, status, priority, metadata, createdAt, updatedAt)
       VALUES (?, ?, 'pending', ?, ?, NOW(), NOW())`,
      [
        taskSlug,
        resolvedCommand,
        priority,
        JSON.stringify({ source: "webstore", purchaseId, action, ...metadata }),
      ]
    );

    const executorTaskId = taskResult.insertId;

    const runResult = await query(
      `INSERT INTO webstoreCommandRuns
         (purchaseId, stripeSubscriptionId, action, commandTemplate,
          resolvedCommand, executorTaskId, status, attempts)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0)`,
      [
        purchaseId,
        stripeSubscriptionId || null,
        action,
        cmd.commandTemplate,
        resolvedCommand,
        executorTaskId,
      ]
    );

    runIds.push(runResult.insertId);
  }

  return runIds;
}

/**
 * Execute Discord role commands immediately (no queue needed — Discord API is fast).
 * Each entry in `commands` with commandType === 'discord_role' causes a role
 * add (grant) or remove (revoke) on the recipient's linked Discord account.
 *
 * @param {object} opts
 * @param {number}   opts.purchaseId
 * @param {string|null} opts.stripeSubscriptionId
 * @param {'grant'|'revoke'} opts.action
 * @param {Array<{commandTemplate:string, commandType:string}>} opts.commands
 * @param {string}   opts.recipientMinecraftUsername
 * @param {object}   opts.discordClient  - Discord.js client
 * @param {string}   opts.guildId        - Discord guild ID from config
 */
export async function executeDiscordRoleCommands({
  purchaseId,
  stripeSubscriptionId = null,
  action,
  commands,
  recipientMinecraftUsername,
  discordClient,
  guildId,
}) {
  const roleCmds = (commands || []).filter((c) => c.commandType === "discord_role");
  if (!roleCmds.length) return;

  // Look up the recipient's Discord ID via their Minecraft username
  const userRows = await query(
    "SELECT discordId FROM users WHERE username = ? LIMIT 1",
    [recipientMinecraftUsername]
  );
  const discordId = userRows?.[0]?.discordId;

  if (!discordId) {
    console.warn(
      `[webstore] discord_role ${action}: no Discord account linked for "${recipientMinecraftUsername}" — deferring role commands until they link`
    );
    // 'deferred', not 'failed': the rest of the purchase still delivered, and
    // retryDeferredDiscordRoles() re-drives these when the recipient links their
    // Discord account.
    for (const cmd of roleCmds) {
      await query(
        `INSERT INTO webstoreCommandRuns
           (purchaseId, stripeSubscriptionId, action, commandTemplate,
            resolvedCommand, executorTaskId, status, attempts, lastError)
         VALUES (?, ?, ?, ?, ?, NULL, 'deferred', 0, ?)`,
        [
          purchaseId,
          stripeSubscriptionId || null,
          action,
          cmd.commandTemplate,
          `discord_role:${action}:${cmd.commandTemplate.trim()}`,
          `Recipient "${recipientMinecraftUsername}" has no linked Discord account — deferred until they link`,
        ]
      );
    }
    return;
  }

  let member = null;
  try {
    const guild = discordClient?.guilds?.cache?.get(guildId);
    member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;
  } catch {
    member = null;
  }

  for (const cmd of roleCmds) {
    const roleId = cmd.commandTemplate.trim();
    let status = "completed";
    let lastError = null;

    try {
      if (!member) throw new Error(`Guild member not found for Discord ID ${discordId}`);
      if (action === "grant") {
        await member.roles.add(roleId);
      } else {
        await member.roles.remove(roleId);
      }
    } catch (err) {
      status = "failed";
      lastError = err.message;
      console.error(
        `[webstore] discord_role ${action} role ${roleId} for ${recipientMinecraftUsername}:`,
        err.message
      );
    }

    await query(
      `INSERT INTO webstoreCommandRuns
         (purchaseId, stripeSubscriptionId, action, commandTemplate,
          resolvedCommand, executorTaskId, status, attempts, lastError)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?)`,
      [
        purchaseId,
        stripeSubscriptionId || null,
        action,
        cmd.commandTemplate,
        `discord_role:${action}:${roleId}`,
        status,
        lastError,
      ]
    );
  }
}

/**
 * Re-drive `discord_role` command runs that were left `deferred` because the
 * recipient had no linked Discord account at purchase time. Call this after a
 * user links their Discord account.
 *
 * @param {object} opts
 * @param {number} opts.userId       the Zander user who just linked Discord
 * @param {object} opts.discordClient Discord.js / Sapphire client
 * @param {string} opts.guildId       Discord guild ID (config.discord.guildId)
 * @returns {Promise<{processed:number, completed:number, failed:number}>}
 */
export async function retryDeferredDiscordRoles({ userId, discordClient, guildId }) {
  const result = { processed: 0, completed: 0, failed: 0 };
  if (!userId || !discordClient || !guildId) return result;

  const userRows = await query(
    "SELECT userId, username, discordId FROM users WHERE userId = ? LIMIT 1",
    [userId]
  );
  const user = userRows?.[0];
  if (!user?.discordId || !user?.username) return result;

  // Deferred discord_role runs for purchases whose *recipient* is this user.
  const runs = await query(
    `SELECT cr.commandRunId, cr.action, cr.commandTemplate
       FROM webstoreCommandRuns cr
       JOIN webstorePurchases p ON p.purchaseId = cr.purchaseId
      WHERE cr.status = 'deferred'
        AND cr.resolvedCommand LIKE 'discord_role:%'
        AND LOWER(p.recipientMinecraftUsername) = LOWER(?)`,
    [user.username]
  );
  if (!runs.length) return result;

  let member = null;
  try {
    const guild = discordClient?.guilds?.cache?.get(guildId) || (await discordClient.guilds.fetch(guildId));
    member = guild ? await guild.members.fetch(user.discordId).catch(() => null) : null;
  } catch {
    member = null;
  }

  for (const run of runs) {
    result.processed++;
    const roleId = String(run.commandTemplate || "").trim();
    let status = "completed";
    let lastError = null;
    try {
      if (!member) throw new Error(`Guild member not found for Discord ID ${user.discordId}`);
      if (run.action === "revoke") await member.roles.remove(roleId);
      else await member.roles.add(roleId);
    } catch (err) {
      status = "failed";
      lastError = err.message;
      console.error(
        `[webstore] retryDeferredDiscordRoles: ${run.action} role ${roleId} for ${user.username}:`,
        err.message
      );
    }
    await updateCommandRunStatus(run.commandRunId, status, lastError);
    if (status === "completed") result.completed++;
    else result.failed++;
  }

  console.info(
    `[webstore] retryDeferredDiscordRoles for ${user.username}: ` +
      `${result.completed} granted, ${result.failed} failed of ${result.processed}`
  );
  return result;
}

// ---------------------------------------------------------------------------
// High-level fulfillment helpers
// ---------------------------------------------------------------------------

/**
 * Run all grant commands for a completed purchase.
 * Minecraft commands are queued via executorTasks; Discord role commands run immediately.
 * Marks the purchase fulfilled if there are no commands at all.
 *
 * @param {object} purchase
 * @param {object} item
 * @param {{ discordClient, guildId }} [discord]
 */
export async function fulfillPurchase(purchase, item, discord = {}) {
  if (!item || !Array.isArray(item.grantCommands) || !item.grantCommands.length) {
    await updatePurchaseStatus(purchase.purchaseId, "fulfilled");
    return;
  }

  const metadata = buildCommandMetadata(purchase);
  await enqueueCommands({
    purchaseId: purchase.purchaseId,
    stripeSubscriptionId: purchase.stripeSubscriptionId || null,
    action: "grant",
    commands: item.grantCommands,
    metadata,
  });
  if (discord.discordClient) {
    await executeDiscordRoleCommands({
      purchaseId: purchase.purchaseId,
      stripeSubscriptionId: purchase.stripeSubscriptionId || null,
      action: "grant",
      commands: item.grantCommands,
      recipientMinecraftUsername: purchase.recipientMinecraftUsername,
      discordClient: discord.discordClient,
      guildId: discord.guildId,
    });
  }
}

/**
 * Run grant commands for a subscription renewal period.
 *
 * @param {object} subscription
 * @param {Array<{commandTemplate,commandType}>} grantCommands
 * @param {{ discordClient, guildId }} [discord]
 */
export async function fulfillSubscriptionRenewal(subscription, grantCommands, discord = {}) {
  if (!grantCommands.length) return;

  const metadata = {
    username: subscription.recipientMinecraftUsername,
    purchaserUsername: subscription.purchaserMinecraftUsername,
    purchaseId: subscription.purchaseId,
    itemSlug: subscription.stripePriceId,
    purchaseType: "subscription",
    isGift:
      subscription.recipientMinecraftUsername !== subscription.purchaserMinecraftUsername
        ? "true"
        : "false",
  };

  await enqueueCommands({
    purchaseId: subscription.purchaseId,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    action: "grant",
    commands: grantCommands,
    metadata,
  });
  if (discord.discordClient) {
    await executeDiscordRoleCommands({
      purchaseId: subscription.purchaseId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      action: "grant",
      commands: grantCommands,
      recipientMinecraftUsername: subscription.recipientMinecraftUsername,
      discordClient: discord.discordClient,
      guildId: discord.guildId,
    });
  }
}

/**
 * Run revoke commands when a subscription is cancelled or expires.
 *
 * @param {object} subscription
 * @param {Array<{commandTemplate,commandType}>} revokeCommands
 * @param {{ discordClient, guildId }} [discord]
 */
export async function revokeSubscription(subscription, revokeCommands, discord = {}) {
  if (!revokeCommands.length) return;

  const metadata = {
    username: subscription.recipientMinecraftUsername,
    purchaserUsername: subscription.purchaserMinecraftUsername,
    purchaseId: subscription.purchaseId,
    itemSlug: subscription.stripePriceId,
    purchaseType: "subscription",
    isGift:
      subscription.recipientMinecraftUsername !== subscription.purchaserMinecraftUsername
        ? "true"
        : "false",
  };

  await enqueueCommands({
    purchaseId: subscription.purchaseId,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    action: "revoke",
    commands: revokeCommands,
    metadata,
  });
  if (discord.discordClient) {
    await executeDiscordRoleCommands({
      purchaseId: subscription.purchaseId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      action: "revoke",
      commands: revokeCommands,
      recipientMinecraftUsername: subscription.recipientMinecraftUsername,
      discordClient: discord.discordClient,
      guildId: discord.guildId,
    });
  }
}

function buildCommandMetadata(purchase) {
  return {
    username: purchase.recipientMinecraftUsername,
    purchaserUsername: purchase.purchaserMinecraftUsername,
    purchaseId: purchase.purchaseId,
    itemSlug: purchase.itemSlug,
    purchaseType: purchase.purchaseType,
    isGift: purchase.isGift === 1 || purchase.isGift === true ? "true" : "false",
  };
}

// ---------------------------------------------------------------------------
// Transaction audit ledger
// ---------------------------------------------------------------------------

/**
 * Record an outgoing transaction for the purchaser, plus an incoming
 * transaction for the recipient if they have a registered account (gift case).
 */
export async function createTransactionsForPurchase({
  purchaseId,
  payerUserId,
  payerMinecraftUsername,
  recipientMinecraftUsername,
  amountCents,
  currency,
}) {
  // Outgoing for the payer
  await query(
    `INSERT INTO webstoreTransactions
       (purchaseId, userId, direction, counterpartyMinecraftUsername, amountCents, currency)
     VALUES (?, ?, 'outgoing', ?, ?, ?)`,
    [purchaseId, payerUserId, recipientMinecraftUsername, amountCents, currency]
  );

  // Incoming for the recipient — only if it's a gift to a registered user
  if (payerMinecraftUsername !== recipientMinecraftUsername) {
    const rows = await query(
      "SELECT userId FROM users WHERE username = ? LIMIT 1",
      [recipientMinecraftUsername]
    );
    const recipientUserId = rows?.[0]?.userId;
    if (recipientUserId) {
      await query(
        `INSERT INTO webstoreTransactions
           (purchaseId, userId, direction, counterpartyMinecraftUsername, amountCents, currency)
         VALUES (?, ?, 'incoming', ?, ?, ?)`,
        [purchaseId, recipientUserId, payerMinecraftUsername, amountCents, currency]
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Monthly totals (for the Give / Support page goal bar)
// ---------------------------------------------------------------------------

export async function getMonthlyPurchaseTotals(startDate, endDate) {
  const results = await query(
    `SELECT COALESCE(SUM(amountCents), 0) AS totalCents
     FROM webstorePurchases
     WHERE status IN ('paid', 'fulfilled')
       AND createdAt BETWEEN ? AND ?`,
    [startDate, endDate]
  );
  return Number(results[0]?.totalCents || 0);
}

// ---------------------------------------------------------------------------
// Command sync helpers (used by webstoreCommandSyncCron)
// ---------------------------------------------------------------------------

/**
 * Return command runs that are still queued or processing, joined with their
 * executor task status so the cron can update them accordingly.
 */
export async function getCommandRunsNeedingSync(limit = 100) {
  return query(
    `SELECT cr.commandRunId, cr.purchaseId, cr.executorTaskId, cr.status,
            cr.attempts, et.status AS taskStatus, et.result AS taskResult
     FROM webstoreCommandRuns cr
     JOIN executorTasks et ON cr.executorTaskId = et.executorTaskId
     WHERE cr.status IN ('queued', 'processing')
     ORDER BY cr.updatedAt ASC
     LIMIT ?`,
    [limit]
  );
}

export async function updateCommandRunStatus(commandRunId, status, lastError = null) {
  return query(
    `UPDATE webstoreCommandRuns
     SET status = ?, lastError = ?, updatedAt = NOW()
     WHERE commandRunId = ?`,
    [status, lastError, commandRunId]
  );
}

export async function incrementCommandRunAttempts(commandRunId, lastError = null) {
  return query(
    `UPDATE webstoreCommandRuns
     SET attempts = attempts + 1, lastError = ?, updatedAt = NOW()
     WHERE commandRunId = ?`,
    [lastError, commandRunId]
  );
}

/** Reset an executor task to pending so it is retried by zander-addon. */
export async function resetExecutorTask(executorTaskId) {
  return query(
    `UPDATE executorTasks
     SET status = 'pending', executedBy = NULL, result = NULL,
         processedAt = NULL, updatedAt = NOW()
     WHERE executorTaskId = ?`,
    [executorTaskId]
  );
}

/**
 * Return purchases that have at least one command run, so the cron can
 * determine whether to mark them fulfilled or failed.
 */
export async function getPurchasesWithPendingCommandRuns() {
  // 'deferred' is included so a purchase whose only outstanding run is a
  // deferred discord_role still gets rolled up to 'fulfilled' (the rollup
  // no-ops once the purchase status has settled).
  return query(
    `SELECT DISTINCT purchaseId
     FROM webstoreCommandRuns
     WHERE status IN ('queued', 'processing', 'deferred')`,
    []
  );
}

export async function getAllPurchases(limit = 20, offset = 0) {
  return query(
    `SELECT purchaseId, userId, itemName, purchaseType,
            purchaserMinecraftUsername, recipientMinecraftUsername,
            amountCents, currency, isGift, status, createdAt
     FROM webstorePurchases
     ORDER BY createdAt DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
}

export async function getAllPurchasesCount() {
  const rows = await query("SELECT COUNT(*) AS total FROM webstorePurchases");
  return Number(rows[0]?.total || 0);
}

export async function getActiveSubscriptionsCount() {
  const rows = await query(
    "SELECT COUNT(*) AS total FROM webstoreSubscriptions WHERE status = 'active'"
  );
  return Number(rows[0]?.total || 0);
}

export async function getTotalRevenueCents() {
  const rows = await query(
    `SELECT COALESCE(SUM(amountCents), 0) AS total
     FROM webstorePurchases
     WHERE status IN ('paid', 'fulfilled')`
  );
  return Number(rows[0]?.total || 0);
}

export async function getAllCommands() {
  return query(
    `SELECT commandId, stripePriceId, action, commandType, commandTemplate, serverSlug, sortOrder, createdAt
     FROM webstoreStripeCommands
     ORDER BY stripePriceId ASC, action ASC, sortOrder ASC`
  );
}

// ---------------------------------------------------------------------------
// Webstore command CRUD
// ---------------------------------------------------------------------------

export async function getCommandById(commandId) {
  const rows = await query(
    `SELECT commandId, stripePriceId, action, commandType, commandTemplate, serverSlug, sortOrder, createdAt
     FROM webstoreStripeCommands
     WHERE commandId = ?
     LIMIT 1`,
    [commandId]
  );
  return rows[0] || null;
}

export async function createCommand({ stripePriceId, action, commandType, commandTemplate, serverSlug, sortOrder }) {
  const result = await query(
    `INSERT INTO webstoreStripeCommands
       (stripePriceId, action, commandType, commandTemplate, serverSlug, sortOrder)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      stripePriceId,
      action,
      commandType || "minecraft",
      commandTemplate,
      serverSlug || null,
      parseInt(sortOrder, 10) || 0,
    ]
  );
  return result.insertId;
}

export async function updateCommand(commandId, { action, commandType, commandTemplate, serverSlug, sortOrder }) {
  return query(
    `UPDATE webstoreStripeCommands
     SET action = ?, commandType = ?, commandTemplate = ?, serverSlug = ?, sortOrder = ?
     WHERE commandId = ?`,
    [
      action,
      commandType || "minecraft",
      commandTemplate,
      serverSlug || null,
      parseInt(sortOrder, 10) || 0,
      commandId,
    ]
  );
}

export async function deleteCommand(commandId) {
  return query(
    "DELETE FROM webstoreStripeCommands WHERE commandId = ?",
    [commandId]
  );
}
