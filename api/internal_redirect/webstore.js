/**
 * api/internal_redirect/webstore.js
 *
 * Stripe webhook endpoint for the Webstore module.
 *
 * This plugin is registered with a raw-body content-type parser BEFORE session
 * middleware so that the raw request body required for HMAC verification is
 * preserved intact.
 *
 * Stripe events handled:
 *   checkout.session.completed    — one-time purchase OR subscription initial payment
 *   invoice.payment_succeeded     — subscription renewal (re-grants rank)
 *   invoice.payment_failed        — renewal failure (marks subscription past_due)
 *   customer.subscription.updated — period/status changes, cancel_at_period_end
 *   customer.subscription.deleted — subscription ended → enqueues revoke commands
 *
 * Security:
 *   - HMAC-SHA256 signature verified before any processing
 *   - Replay window limited to ±5 minutes
 *   - All events are recorded to webstoreWebhookEvents before work begins;
 *     subsequent deliveries of the same event ID are no-ops (idempotent)
 */

import crypto from "crypto";
import fetch from "node-fetch";
import { Colors } from "discord.js";
import { Webhook, MessageBuilder } from "discord-webhook-node";
import { sendWebhookMessage } from "../../lib/discord/webhooks.mjs";
import { client as discordClient } from "../../controllers/discordController.js";
import {
  createTransactionsForPurchase,
  fetchStripeSubscription,
  fulfillPurchase,
  fulfillSubscriptionRenewal,
  findWebstoreItem,
  getCommandsByPriceId,
  getPurchaseBySessionId,
  getSubscriptionByStripeId,
  hasWebhookEvent,
  recordWebhookEvent,
  revokeSubscription,
  updatePurchasePayment,
  updatePurchaseStatus,
  updateSubscriptionPeriod,
  updateSubscriptionStatus,
  upsertSubscription,
} from "../../controllers/webstoreController.js";
import {
  createTransaction,
  getDefaultWebstoreAccount,
} from "../../controllers/financeController.js";

// ---------------------------------------------------------------------------
// Stripe signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the stripe-signature header against the raw request body.
 *
 * Stripe sends: "t=<timestamp>,v1=<sig1>,v1=<sig2>,..."
 * We recompute HMAC-SHA256("<timestamp>.<rawBody>", secret) and compare
 * using a constant-time comparison to prevent timing attacks.
 *
 * @returns {boolean}
 */
function verifyStripeSignature({ signatureHeader, rawPayload, secret }) {
  if (!signatureHeader || !secret) return false;

  // Parse the t= timestamp and all v1= signatures
  let timestamp = null;
  const v1Signatures = [];

  for (const part of signatureHeader.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === "t") timestamp = Number(val);
    if (key === "v1") v1Signatures.push(val);
  }

  if (!timestamp || !v1Signatures.length) return false;

  // Reject events more than 5 minutes old to block replay attacks
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > 300) return false;

  const payloadStr = Buffer.isBuffer(rawPayload)
    ? rawPayload.toString("utf8")
    : String(rawPayload);

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payloadStr}`)
    .digest("hex");

  return v1Signatures.some((sig) => {
    try {
      // Pad to equal length for timingSafeEqual
      const sigBuf = Buffer.from(sig, "hex");
      const expBuf = Buffer.from(expected, "hex");
      if (sigBuf.length !== expBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Discord notification helper
// ---------------------------------------------------------------------------

async function sendToWebhook(webhookUrl, title, fields, color = Colors.Green) {
  if (!webhookUrl) return;
  try {
    const hook = new Webhook(webhookUrl);
    const embed = new MessageBuilder().setTitle(title).setColor(color).setTimestamp();
    for (const [name, value, inline = false] of fields) {
      embed.addField(name, String(value || "—"), inline);
    }
    await sendWebhookMessage(hook, embed, { context: "webstore" });
  } catch (err) {
    console.error("[webstore] Discord notification failed:", err.message);
  }
}

async function notifyWebstore(config, title, fields, color = Colors.Green) {
  await sendToWebhook(config?.discord?.webhooks?.webstoreChannel, title, fields, color);
}

async function notifyPurchase(config, purchase) {
  const webhookUrl = config?.discord?.webhooks?.webstoreChannel;
  if (!webhookUrl) return;

  const recipient = purchase.recipientMinecraftUsername || "—";
  const purchaser = purchase.purchaserMinecraftUsername || "—";
  const price = `${(purchase.currency || "USD").toUpperCase()} ${(purchase.amountCents / 100).toFixed(2)}`;
  const type = purchase.purchaseType === "subscription" ? "Subscription" : "One-time";

  const fields = [
    ["Package", purchase.itemName, false],
    ["Player", recipient, true],
    ["Price", price, true],
    ["Type", type, true],
  ];

  if (purchase.isGift) {
    fields.push(["Gifted by", purchaser, true]);
  }

  await sendToWebhook(webhookUrl, "🛒 New Purchase", fields, Colors.Gold);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export default function webstoreWebhookRoutes(app, config) {
  /**
   * POST /api/webstore/stripe/webhook
   *
   * Receives Stripe webhook events.  The response is sent immediately after
   * signature verification; actual processing runs asynchronously via
   * setImmediate so we don't risk Stripe's 30-second timeout.
   */
  app.post("/api/webstore/stripe/webhook", async function (req, res) {
    const signature = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!signature || !webhookSecret) {
      res.status(400);
      return res.send({ success: false, message: "Webhook not configured." });
    }

    const rawPayload = req.body;
    if (!rawPayload) {
      res.status(400);
      return res.send({ success: false, message: "Empty payload." });
    }

    if (!verifyStripeSignature({ signatureHeader: signature, rawPayload, secret: webhookSecret })) {
      res.status(400);
      return res.send({ success: false, message: "Signature verification failed." });
    }

    let event;
    try {
      const payloadStr = Buffer.isBuffer(rawPayload)
        ? rawPayload.toString("utf8")
        : String(rawPayload);
      event = JSON.parse(payloadStr);
    } catch {
      res.status(400);
      return res.send({ success: false, message: "Invalid JSON payload." });
    }

    // Acknowledge to Stripe immediately; process asynchronously
    res.send({ success: true, received: true });

    setImmediate(() => {
      processWebhookEvent(event, config).catch((err) => {
        console.error("[webstore] Unhandled error in processWebhookEvent:", err);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Async event dispatch
// ---------------------------------------------------------------------------

async function processWebhookEvent(event, config) {
  const { id: eventId, type: eventType } = event;

  // Idempotency guard — skip events already processed
  if (await hasWebhookEvent(eventId)) {
    console.log(`[webstore] Duplicate event ignored: ${eventId} (${eventType})`);
    return;
  }

  try {
    switch (eventType) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event, config);
        break;

      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(event, config);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event, config);
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event, config);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event, config);
        break;

      default:
        // Record and ignore events we don't act on
        await recordWebhookEvent({
          stripeEventId: eventId,
          purchaseId: null,
          eventType,
          payload: { type: eventType },
        });
        break;
    }
  } catch (err) {
    console.error(`[webstore] Error processing ${eventType} (${eventId}):`, err);
    // Still record the event ID so we don't retry in an infinite loop
    try {
      await recordWebhookEvent({
        stripeEventId: eventId,
        purchaseId: null,
        eventType,
        payload: { error: err.message },
      });
    } catch {
      // ignore recording failure
    }
  }
}

// ---------------------------------------------------------------------------
// Handler: checkout.session.completed
// Fires for both one-time purchases and the initial payment of a subscription.
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(event, config) {
  const session = event.data.object;
  const purchase = await getPurchaseBySessionId(session.id);

  if (!purchase) {
    console.warn(`[webstore] checkout.session.completed: no purchase record for session ${session.id}`);
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: null,
      eventType: event.type,
      payload: { sessionId: session.id },
    });
    return;
  }

  // Guard against reprocessing (e.g. duplicate delivery after a slow handler)
  if (purchase.status !== "pending") {
    console.log(
      `[webstore] checkout.session.completed: purchase ${purchase.purchaseId} already in status '${purchase.status}' — skipping`
    );
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: purchase.purchaseId,
      eventType: event.type,
      payload: { skipped: true },
    });
    return;
  }

  // For non-subscription payments, confirm payment_status is 'paid'
  if (purchase.purchaseType === "one_time" && session.payment_status !== "paid") {
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: purchase.purchaseId,
      eventType: event.type,
      payload: { payment_status: session.payment_status },
    });
    return;
  }

  // --- Update purchase record ---
  await updatePurchasePayment({
    purchaseId: purchase.purchaseId,
    status: "paid",
    paymentIntentId: session.payment_intent || null,
    subscriptionId: session.subscription || null,
    customerId: session.customer || null,
  });

  // Record event now (before fulfillment) so any subsequent delivery is a no-op
  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: purchase.purchaseId,
    eventType: event.type,
    payload: { mode: session.mode, payment_status: session.payment_status },
  });

  // --- Subscription: create/update subscription record ---
  if (purchase.purchaseType === "subscription" && session.subscription) {
    const stripeSub = await fetchStripeSubscription(session.subscription);
    await upsertSubscription({
      purchaseId: purchase.purchaseId,
      stripeSubscriptionId: session.subscription,
      stripeCustomerId: session.customer || null,
      stripePriceId: purchase.itemSlug,
      recipientMinecraftUsername: purchase.recipientMinecraftUsername,
      purchaserMinecraftUsername: purchase.purchaserMinecraftUsername,
      purchaserUserId: purchase.userId,
      status: "active",
      currentPeriodStart: stripeSub?.current_period_start ?? null,
      currentPeriodEnd: stripeSub?.current_period_end ?? null,
      cancelAtPeriodEnd: stripeSub?.cancel_at_period_end ?? false,
    });
  }

  // --- Enqueue grant commands ---
  const item = await findWebstoreItem(purchase.itemSlug);
  await fulfillPurchase(purchase, item, { discordClient, guildId: config?.discord?.guildId });

  // --- Record transaction ---
  await createTransactionsForPurchase({
    purchaseId: purchase.purchaseId,
    payerUserId: purchase.userId,
    payerMinecraftUsername: purchase.purchaserMinecraftUsername,
    recipientMinecraftUsername: purchase.recipientMinecraftUsername,
    amountCents: purchase.amountCents,
    currency: purchase.currency,
  });

  // --- Record income in finance ledger ---
  try {
    const account = await getDefaultWebstoreAccount();
    if (account) {
      const recipient = purchase.recipientMinecraftUsername || purchase.purchaserMinecraftUsername || "unknown";
      await createTransaction({
        type: "income",
        amountCents: purchase.amountCents,
        currency: purchase.currency || "USD",
        accountId: account.accountId,
        description: `${purchase.itemName} — ${recipient}`,
        notes: `Webstore purchase #${purchase.purchaseId}. Type: ${purchase.purchaseType}.${purchase.isGift ? ` Gift from ${purchase.purchaserMinecraftUsername}.` : ""}`,
        transactionDate: new Date().toISOString().slice(0, 10),
        createdByUserId: 0,
      });
    } else {
      console.warn("[webstore] No finance account found — skipping income record for purchase", purchase.purchaseId);
    }
  } catch (err) {
    console.error("[webstore] Failed to record finance income for purchase", purchase.purchaseId, err.message);
  }

  await notifyPurchase(config, purchase);
}

// ---------------------------------------------------------------------------
// Handler: invoice.payment_succeeded
// Fires on every successful subscription renewal (and on first payment, but we
// skip billing_reason === 'subscription_create' to avoid double-granting).
// ---------------------------------------------------------------------------

async function handleInvoicePaymentSucceeded(event, config) {
  const invoice = event.data.object;

  // The initial subscription payment is handled by checkout.session.completed
  if (!invoice.subscription || invoice.billing_reason === "subscription_create") {
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: null,
      eventType: event.type,
      payload: { billing_reason: invoice.billing_reason },
    });
    return;
  }

  const subscription = await getSubscriptionByStripeId(invoice.subscription);
  if (!subscription) {
    console.warn(
      `[webstore] invoice.payment_succeeded: no subscription record for ${invoice.subscription}`
    );
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: null,
      eventType: event.type,
      payload: { subscriptionId: invoice.subscription },
    });
    return;
  }

  // Fetch updated period info from Stripe
  const stripeSub = await fetchStripeSubscription(invoice.subscription);
  if (stripeSub) {
    await updateSubscriptionPeriod(
      invoice.subscription,
      stripeSub.current_period_start,
      stripeSub.current_period_end
    );
  }

  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: subscription.purchaseId,
    eventType: event.type,
    payload: {
      subscriptionId: invoice.subscription,
      billing_reason: invoice.billing_reason,
    },
  });

  // Re-enqueue grant commands for the renewed period
  const { grantCommands } = await getCommandsByPriceId(subscription.stripePriceId);
  if (grantCommands.length > 0) {
    await fulfillSubscriptionRenewal(subscription, grantCommands, { discordClient, guildId: config?.discord?.guildId });
  }

  // --- Record renewal income in finance ledger ---
  // (The initial payment is recorded by handleCheckoutCompleted; every
  // subsequent renewal must be recorded here or it's invisible to the
  // finance dashboard even though real money changed hands.)
  try {
    const account = await getDefaultWebstoreAccount();
    if (account && typeof invoice.amount_paid === "number") {
      const item = await findWebstoreItem(subscription.stripePriceId).catch(() => null);
      const itemName = item?.displayName || subscription.stripePriceId;
      const recipient = subscription.recipientMinecraftUsername || subscription.purchaserMinecraftUsername || "unknown";
      await createTransaction({
        type: "income",
        amountCents: invoice.amount_paid,
        currency: (invoice.currency || "usd").toUpperCase(),
        accountId: account.accountId,
        description: `${itemName} — ${recipient} (renewal)`,
        notes: `Webstore subscription renewal. Purchase #${subscription.purchaseId}. Stripe subscription ${invoice.subscription}.`,
        transactionDate: new Date().toISOString().slice(0, 10),
        createdByUserId: 0,
      });
    } else if (!account) {
      console.warn("[webstore] No finance account found — skipping renewal income record for subscription", invoice.subscription);
    }
  } catch (err) {
    console.error("[webstore] Failed to record renewal income for subscription", invoice.subscription, err.message);
  }

  const periodEndDate = stripeSub?.current_period_end
    ? new Date(stripeSub.current_period_end * 1000).toISOString().slice(0, 10)
    : "unknown";

  const renewalFields = [
    ["Player", subscription.recipientMinecraftUsername, true],
    ["Purchaser", subscription.purchaserMinecraftUsername, true],
    ["Price ID", subscription.stripePriceId, false],
    ["Next Renewal", periodEndDate, true],
  ];
  await notifyWebstore(config, "🔄 Subscription Renewed", renewalFields, Colors.Blue);
}

// ---------------------------------------------------------------------------
// Handler: invoice.payment_failed
// Marks the subscription past_due.  On the first couple of failures we wait —
// Stripe retries and will fire customer.subscription.deleted if it gives up.
// Once the invoice has failed FAILURE_REVOKE_THRESHOLD times we stop waiting
// and revoke the rank ourselves, so a player cannot keep a paid rank for the
// full length of Stripe's retry schedule on a card that will never clear.
// ---------------------------------------------------------------------------

/** Failed payment attempts on one invoice before we revoke the rank. */
const FAILURE_REVOKE_THRESHOLD = 3;

async function handleInvoicePaymentFailed(event, config) {
  const invoice = event.data.object;

  if (!invoice.subscription) {
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: null,
      eventType: event.type,
      payload: { invoiceId: invoice.id },
    });
    return;
  }

  const subscription = await getSubscriptionByStripeId(invoice.subscription);
  if (!subscription) {
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: null,
      eventType: event.type,
      payload: { subscriptionId: invoice.subscription },
    });
    return;
  }

  const attemptCount = Number(invoice.attempt_count) || 1;
  const shouldRevoke =
    attemptCount >= FAILURE_REVOKE_THRESHOLD &&
    subscription.status !== "unpaid" &&
    subscription.status !== "cancelled" &&
    subscription.status !== "expired";

  await updateSubscriptionStatus(invoice.subscription, shouldRevoke ? "unpaid" : "past_due");

  // Revoke the rank once the invoice has failed enough times.  Subscriptions
  // already in a revoked state are skipped so a repeated failure on the same
  // subscription does not enqueue duplicate revoke commands.
  let revokeCommands = [];
  if (shouldRevoke) {
    ({ revokeCommands } = await getCommandsByPriceId(subscription.stripePriceId));
    if (revokeCommands.length > 0) {
      await revokeSubscription(subscription, revokeCommands, {
        discordClient,
        guildId: config?.discord?.guildId,
      });
    }
  }

  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: subscription.purchaseId,
    eventType: event.type,
    payload: {
      subscriptionId: invoice.subscription,
      attempt_count: attemptCount,
      revoked: shouldRevoke,
      revokeCommands: revokeCommands.length,
    },
  });

  const failedFields = [
    ["Player", subscription.recipientMinecraftUsername, true],
    ["Price ID", subscription.stripePriceId, true],
    ["Attempt", String(attemptCount), true],
  ];

  if (shouldRevoke) {
    failedFields.push(["Revoke commands", String(revokeCommands.length), true]);
    await notifyWebstore(
      config,
      `❌ Subscription Revoked — ${attemptCount} Failed Payments`,
      failedFields,
      Colors.Red
    );
  } else {
    await notifyWebstore(config, "⚠️ Subscription Payment Failed", failedFields, Colors.Yellow);
  }
}

// ---------------------------------------------------------------------------
// Handler: customer.subscription.updated
// Syncs period and status changes (e.g. cancel_at_period_end toggled).
// ---------------------------------------------------------------------------

async function handleSubscriptionUpdated(event, config) {
  const stripeSub = event.data.object;
  const subscription = await getSubscriptionByStripeId(stripeSub.id);

  if (!subscription) {
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: null,
      eventType: event.type,
      payload: { subscriptionId: stripeSub.id },
    });
    return;
  }

  await upsertSubscription({
    purchaseId: subscription.purchaseId,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    stripeCustomerId: subscription.stripeCustomerId,
    stripePriceId: subscription.stripePriceId,
    recipientMinecraftUsername: subscription.recipientMinecraftUsername,
    purchaserMinecraftUsername: subscription.purchaserMinecraftUsername,
    purchaserUserId: subscription.purchaserUserId,
    status: stripeStatusToLocal(stripeSub.status),
    currentPeriodStart: stripeSub.current_period_start ?? null,
    currentPeriodEnd: stripeSub.current_period_end ?? null,
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
  });

  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: subscription.purchaseId,
    eventType: event.type,
    payload: {
      subscriptionId: stripeSub.id,
      status: stripeSub.status,
      cancel_at_period_end: stripeSub.cancel_at_period_end,
    },
  });
}

// ---------------------------------------------------------------------------
// Handler: customer.subscription.deleted
// Subscription has ended — enqueue revoke commands.
// ---------------------------------------------------------------------------

async function handleSubscriptionDeleted(event, config) {
  const stripeSub = event.data.object;
  const subscription = await getSubscriptionByStripeId(stripeSub.id);

  if (!subscription) {
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: null,
      eventType: event.type,
      payload: { subscriptionId: stripeSub.id },
    });
    return;
  }

  const cancelledAt = stripeSub.canceled_at
    ? new Date(stripeSub.canceled_at * 1000)
    : new Date();

  await updateSubscriptionStatus(stripeSub.id, "cancelled", cancelledAt);

  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: subscription.purchaseId,
    eventType: event.type,
    payload: {
      subscriptionId: stripeSub.id,
      canceled_at: stripeSub.canceled_at,
      cancellation_reason: stripeSub.cancellation_details?.reason,
    },
  });

  // Enqueue revoke commands for the recipient
  const { revokeCommands } = await getCommandsByPriceId(subscription.stripePriceId);
  if (revokeCommands.length > 0) {
    await revokeSubscription(subscription, revokeCommands, { discordClient, guildId: config?.discord?.guildId });
  }

  const cancelledFields = [
    ["Player", subscription.recipientMinecraftUsername, true],
    ["Purchaser", subscription.purchaserMinecraftUsername, true],
    ["Price ID", subscription.stripePriceId, false],
    ["Reason", stripeSub.cancellation_details?.reason || "unknown", true],
    ["Revoke commands", String(revokeCommands.length), true],
  ];
  await notifyWebstore(config, "❌ Subscription Cancelled", cancelledFields, Colors.Red);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a Stripe subscription status string to our local ENUM. */
function stripeStatusToLocal(stripeStatus) {
  const map = {
    active: "active",
    trialing: "active",
    past_due: "past_due",
    incomplete: "past_due",
    incomplete_expired: "expired",
    canceled: "cancelled",
    unpaid: "unpaid",
  };
  return map[stripeStatus] || "past_due";
}
