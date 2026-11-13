// TODO: These proxies authenticate an HTTP round trip from this app back to
// itself, which is why the app has to hold an API credential at all. The
// long-term fix is to call the underlying controller function directly
// in-process and drop the self-call entirely; until then this route depends on
// the `zander-web-internal` client in INTERNAL_API_KEY.
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
 *   checkout.session.async_payment_succeeded — delayed payment (bank debit etc.) cleared
 *   checkout.session.async_payment_failed    — delayed payment failed
 *   invoice.payment_succeeded     — subscription renewal (re-grants rank)
 *   invoice.payment_failed        — renewal failure (marks subscription past_due)
 *   customer.subscription.updated — period/status changes, cancel_at_period_end
 *   customer.subscription.deleted — subscription ended → enqueues revoke commands
 *   charge.refunded               — refund: reverses revenue, revokes a fully refunded one-time purchase
 *   charge.dispute.created        — chargeback opened: staff notification
 *   charge.dispute.closed         — chargeback lost: treated like a full refund
 *
 * Every one of these must be enabled on the webhook endpoint in the Stripe
 * dashboard; events that are not sent are never handled.
 *
 * Security:
 *   - HMAC-SHA256 signature verified before any processing
 *   - Replay window limited to ±5 minutes
 *   - Each event is claimed in webstoreWebhookEvents before work begins, so a
 *     duplicate delivery is a no-op. The event is processed before Stripe gets
 *     its response: on failure the claim is released and a 500 is returned, so
 *     Stripe retries it. Handlers are written so a retry after a partial run
 *     does not double-grant or double-record.
 */

import crypto from "crypto";
import fetch from "node-fetch";
import { publicGifterName } from "../../lib/webstore/giftPrivacy.mjs";
import { Colors } from "discord.js";
import { Webhook, MessageBuilder } from "discord-webhook-node";
import { sendWebhookMessage } from "../../lib/discord/webhooks.mjs";
import { client as discordClient } from "../../controllers/discordController.js";
import {
  completeWebhookEvent,
  countPurchaseCommandRuns,
  createRefundTransaction,
  createTransactionsForPurchase,
  fetchStripeCharge,
  fetchStripeInvoice,
  fetchStripeSubscription,
  fulfillPurchase,
  fulfillSubscriptionRenewal,
  findWebstoreItem,
  getCommandsByPriceId,
  getPurchaseById,
  getPurchaseByPaymentIntentId,
  getPurchaseBySessionId,
  getRecordedRefundCentsForCharge,
  getSubscriptionByStripeId,
  claimWebhookEvent,
  isWebhookEventCompleted,
  recordWebhookEvent,
  releaseWebhookEvent,
  revokePurchase,
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
import {
  planSubscriptionUpdate,
  TERMINAL_SUBSCRIPTION_STATUSES,
} from "../../lib/webstore/subscriptionStatus.mjs";

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
  // The webstore channel may be player-visible, so anonymous gifts stay anonymous.
  const purchaser = publicGifterName(purchase) || "—";
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
   * Receives Stripe webhook events. The event is processed before replying:
   * acknowledging first meant a failure (or a restart) mid-fulfilment lost
   * the event for good, since Stripe had its 2xx and the claim blocked resends.
   *   200 — processed, or already processed by an earlier delivery
   *   409 — another delivery is processing it right now; Stripe retries later
   *   500 — processing failed; the claim was released so Stripe retries
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

    let outcome;
    try {
      outcome = await processWebhookEvent(event, config);
    } catch (err) {
      console.error(`[webstore] Error processing ${event?.type} (${event?.id}); Stripe will retry:`, err);
      res.status(500);
      return res.send({ success: false, message: "Processing failed." });
    }

    if (outcome === "in_progress") {
      res.status(409);
      return res.send({ success: false, message: "Event is already being processed." });
    }
    return res.send({ success: true, received: true });
  });
}

// ---------------------------------------------------------------------------
// Async event dispatch
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<"processed"|"duplicate"|"in_progress">}
 * @throws when processing failed (the claim has been released for a retry)
 */
async function processWebhookEvent(event, config) {
  const { id: eventId, type: eventType } = event;

  // Idempotency guard — claim the event before doing any work. This is an
  // atomic INSERT against a UNIQUE index rather than a read-then-write, so a
  // retry arriving mid-processing loses the race instead of double-crediting.
  if (!(await claimWebhookEvent(eventId, eventType))) {
    if (await isWebhookEventCompleted(eventId)) {
      console.log(`[webstore] Duplicate event ignored: ${eventId} (${eventType})`);
      return "duplicate";
    }
    console.log(`[webstore] Event ${eventId} (${eventType}) is still being processed by another delivery`);
    return "in_progress";
  }

  try {
    switch (eventType) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await handleCheckoutCompleted(event, config);
        break;

      case "checkout.session.async_payment_failed":
        await handleCheckoutAsyncPaymentFailed(event, config);
        break;

      case "charge.refunded":
        await handleChargeRefunded(event, config);
        break;

      case "charge.dispute.created":
        await handleDisputeCreated(event, config);
        break;

      case "charge.dispute.closed":
        await handleDisputeClosed(event, config);
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
    // Release the claim so Stripe's retry (or a manual resend) runs it again.
    // Stripe stops retrying on its own after ~3 days, so this cannot loop forever.
    try {
      await releaseWebhookEvent(eventId);
    } catch (releaseErr) {
      // The claim then goes stale and a later retry takes it over.
      console.error(`[webstore] Could not release claim on ${eventId}:`, releaseErr.message);
    }
    throw err;
  }

  await completeWebhookEvent(eventId);
  return "processed";
}

// ---------------------------------------------------------------------------
// Handler: checkout.session.completed
// Fires for both one-time purchases and the initial payment of a subscription.
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(event, config) {
  const session = event.data.object;
  const purchase = await getPurchaseBySessionId(session.id);

  if (!purchase) {
    // Checkout writes the pending row before redirecting to Stripe, so a
    // session carrying our metadata must have one: throw so Stripe retries
    // rather than dropping a paid order. Sessions from other integrations on
    // the same Stripe account have no itemSlug and are ignored.
    if (session.metadata?.itemSlug) {
      throw new Error(`${event.type}: no purchase record for webstore session ${session.id}`);
    }
    console.warn(`[webstore] ${event.type}: no purchase record for session ${session.id}`);
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: null,
      eventType: event.type,
      payload: { sessionId: session.id },
    });
    return;
  }

  // 'pending' is the normal case. 'paid' means an earlier delivery confirmed
  // the payment but failed before fulfilment finished (its claim was released
  // so this retry can resume); every step below is safe to repeat. Anything
  // else has already settled.
  if (purchase.status !== "pending" && purchase.status !== "paid") {
    console.log(
      `[webstore] ${event.type}: purchase ${purchase.purchaseId} already in status '${purchase.status}' — skipping`
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

  const wasPending = purchase.status === "pending";

  // Resolve the item before writing anything: it calls the Stripe API, and a
  // failure here should leave the purchase untouched for the retry.
  const item = await findWebstoreItem(purchase.itemSlug);

  // Record what Stripe actually charged. The pending row holds the catalogue
  // price in the default currency, but Checkout may charge a currency_options
  // price in the buyer's currency, or apply a discount or tax.
  const amountCents = Number.isInteger(session.amount_total) ? session.amount_total : purchase.amountCents;
  const currency = session.currency ? String(session.currency).toLowerCase() : purchase.currency;
  const paidPurchase = {
    ...purchase,
    status: "paid",
    amountCents,
    currency,
    stripePaymentIntentId: session.payment_intent || purchase.stripePaymentIntentId || null,
    stripeSubscriptionId: session.subscription || purchase.stripeSubscriptionId || null,
    stripeCustomerId: session.customer || purchase.stripeCustomerId || null,
  };

  // --- Update purchase record ---
  await updatePurchasePayment({
    purchaseId: purchase.purchaseId,
    status: "paid",
    paymentIntentId: paidPurchase.stripePaymentIntentId,
    subscriptionId: paidPurchase.stripeSubscriptionId,
    customerId: paidPurchase.stripeCustomerId,
    amountCents,
    currency,
  });

  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: purchase.purchaseId,
    eventType: event.type,
    payload: { mode: session.mode, payment_status: session.payment_status, resumed: !wasPending },
  });

  // --- Subscription: create the subscription record (once) ---
  if (purchase.purchaseType === "subscription" && session.subscription) {
    const existingSub = wasPending ? null : await getSubscriptionByStripeId(session.subscription);
    if (!existingSub) {
      const stripeSub = await fetchStripeSubscription(session.subscription);
      await upsertSubscription({
        purchaseId: purchase.purchaseId,
        stripeSubscriptionId: session.subscription,
        stripeCustomerId: session.customer || null,
        stripePriceId: purchase.itemSlug,
        recipientMinecraftUsername: purchase.recipientMinecraftUsername,
        purchaserMinecraftUsername: purchase.purchaserMinecraftUsername,
        purchaserUserId: purchase.userId,
        isAnonymous: purchase.isAnonymous,
        status: "active",
        currentPeriodStart: stripeSub?.current_period_start ?? null,
        currentPeriodEnd: stripeSub?.current_period_end ?? null,
        cancelAtPeriodEnd: stripeSub?.cancel_at_period_end ?? false,
      });
    }
  }

  // --- Record transaction (keyed by session, so a retry cannot duplicate it) ---
  await createTransactionsForPurchase({
    purchaseId: purchase.purchaseId,
    payerUserId: purchase.userId,
    payerMinecraftUsername: purchase.purchaserMinecraftUsername,
    recipientMinecraftUsername: purchase.recipientMinecraftUsername,
    amountCents,
    currency,
    stripeRef: `checkout:${session.id}`,
  });

  // --- Record income in finance ledger ---
  try {
    const account = await getDefaultWebstoreAccount();
    if (account) {
      const recipient = purchase.recipientMinecraftUsername || purchase.purchaserMinecraftUsername || "unknown";
      await createTransaction({
        type: "income",
        amountCents,
        currency: currency || "USD",
        accountId: account.accountId,
        description: `${purchase.itemName} — ${recipient}`,
        notes: `Webstore purchase #${purchase.purchaseId}. Type: ${purchase.purchaseType}.${purchase.isGift ? ` Gift from ${purchase.purchaserMinecraftUsername}.` : ""}`,
        transactionDate: new Date().toISOString().slice(0, 10),
        createdByUserId: 0,
        externalRef: `webstore:checkout:${session.id}`,
      });
    } else {
      console.warn("[webstore] No finance account found — skipping income record for purchase", purchase.purchaseId);
    }
  } catch (err) {
    console.error("[webstore] Failed to record finance income for purchase", purchase.purchaseId, err.message);
  }

  // --- Enqueue grant commands (last, and only once) ---
  const alreadyGranted = !wasPending && (await countPurchaseCommandRuns(purchase.purchaseId, "grant")) > 0;
  if (!alreadyGranted) {
    await fulfillPurchase(paidPurchase, item, { discordClient, guildId: config?.discord?.guildId });
  }

  // A resumed run whose earlier attempt never reached the grant step never
  // announced the purchase either, so key the notice off the grant, not wasPending.
  if (!alreadyGranted) await notifyPurchase(config, paidPurchase);
}

// ---------------------------------------------------------------------------
// Handler: checkout.session.async_payment_failed
// A delayed payment method (bank debit etc.) did not clear.
// ---------------------------------------------------------------------------

async function handleCheckoutAsyncPaymentFailed(event, config) {
  const session = event.data.object;
  const purchase = await getPurchaseBySessionId(session.id);

  if (purchase && purchase.status === "pending") {
    await updatePurchaseStatus(purchase.purchaseId, "failed");
    await notifyWebstore(
      config,
      "⚠️ Delayed Payment Failed",
      [
        ["Package", purchase.itemName, false],
        ["Player", purchase.recipientMinecraftUsername, true],
        ["Purchase", `#${purchase.purchaseId}`, true],
      ],
      Colors.Yellow
    );
  }

  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: purchase?.purchaseId || null,
    eventType: event.type,
    payload: { sessionId: session.id, payment_status: session.payment_status },
  });
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

  // A delayed delivery can arrive after the subscription has already ended
  // (and its rank was revoked). The money is still recorded, but the period is
  // not reopened and nothing is re-granted.
  const hasEnded = TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status);

  // Fetch updated period info from Stripe
  const stripeSub = await fetchStripeSubscription(invoice.subscription);
  if (stripeSub && !hasEnded) {
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
      ended: hasEnded,
    },
  });

  // --- Record the renewal payment (keyed by invoice, so retries cannot duplicate it) ---
  // Renewals never create a webstorePurchases row, so without this they were
  // missing from webstore revenue and the public community-support figure.
  if (typeof invoice.amount_paid === "number") {
    await createTransactionsForPurchase({
      purchaseId: subscription.purchaseId,
      payerUserId: subscription.purchaserUserId,
      payerMinecraftUsername: subscription.purchaserMinecraftUsername,
      recipientMinecraftUsername: subscription.recipientMinecraftUsername,
      amountCents: invoice.amount_paid,
      currency: String(invoice.currency || "usd").toLowerCase(),
      stripeRef: `invoice:${invoice.id}`,
    });
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
        externalRef: `webstore:invoice:${invoice.id}`,
      });
    } else if (!account) {
      console.warn("[webstore] No finance account found — skipping renewal income record for subscription", invoice.subscription);
    }
  } catch (err) {
    console.error("[webstore] Failed to record renewal income for subscription", invoice.subscription, err.message);
  }

  if (hasEnded) {
    console.warn(
      `[webstore] invoice.payment_succeeded for ended subscription ${invoice.subscription} (status '${subscription.status}') — not re-granting`
    );
    return;
  }

  // Re-enqueue grant commands for the renewed period
  const { grantCommands } = await getCommandsByPriceId(subscription.stripePriceId);
  if (grantCommands.length > 0) {
    await fulfillSubscriptionRenewal(subscription, grantCommands, { discordClient, guildId: config?.discord?.guildId });
  }

  const periodEndDate = stripeSub?.current_period_end
    ? new Date(stripeSub.current_period_end * 1000).toISOString().slice(0, 10)
    : "unknown";

  const renewalFields = [
    ["Player", subscription.recipientMinecraftUsername, true],
    ["Purchaser", publicGifterName(subscription), true],
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

  // Stripe does not deliver in order: never revive an ended subscription, and
  // drop an update older than the last one applied.
  const plan = planSubscriptionUpdate({
    currentStatus: subscription.status,
    lastStripeEventAt: subscription.lastStripeEventAt,
    eventCreated: event.created,
    incomingStripeStatus: stripeSub.status,
  });

  if (plan.apply) {
    await upsertSubscription({
      purchaseId: subscription.purchaseId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      stripeCustomerId: subscription.stripeCustomerId,
      stripePriceId: subscription.stripePriceId,
      recipientMinecraftUsername: subscription.recipientMinecraftUsername,
      purchaserMinecraftUsername: subscription.purchaserMinecraftUsername,
      purchaserUserId: subscription.purchaserUserId,
      isAnonymous: subscription.isAnonymous,
      status: plan.status,
      currentPeriodStart: stripeSub.current_period_start ?? null,
      currentPeriodEnd: stripeSub.current_period_end ?? null,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
      lastStripeEventAt: Number.isInteger(event.created) ? event.created : null,
    });
  } else {
    console.log(
      `[webstore] customer.subscription.updated ignored for ${stripeSub.id}: ${plan.reason} (local status '${subscription.status}')`
    );
  }

  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: subscription.purchaseId,
    eventType: event.type,
    payload: {
      subscriptionId: stripeSub.id,
      status: stripeSub.status,
      cancel_at_period_end: stripeSub.cancel_at_period_end,
      ...(plan.apply ? {} : { ignored: plan.reason }),
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
    ["Purchaser", publicGifterName(subscription), true],
    ["Price ID", subscription.stripePriceId, false],
    ["Reason", stripeSub.cancellation_details?.reason || "unknown", true],
    ["Revoke commands", String(revokeCommands.length), true],
  ];
  await notifyWebstore(config, "❌ Subscription Cancelled", cancelledFields, Colors.Red);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the webstore purchase a Stripe charge paid for. One-time purchases are
 * matched by payment intent; subscription charges via their invoice.
 *
 * @returns {Promise<{purchase: object|null, subscription: object|null}>}
 */
async function resolvePurchaseForCharge({ paymentIntentId, invoiceId }) {
  const byIntent = await getPurchaseByPaymentIntentId(paymentIntentId);
  if (byIntent) return { purchase: byIntent, subscription: null };

  if (invoiceId) {
    const invoice = await fetchStripeInvoice(invoiceId);
    const subscriptionId = typeof invoice?.subscription === "string" ? invoice.subscription : invoice?.subscription?.id;
    if (subscriptionId) {
      const subscription = await getSubscriptionByStripeId(subscriptionId);
      if (subscription) {
        return { purchase: await getPurchaseById(subscription.purchaseId), subscription };
      }
    }
  }
  return { purchase: null, subscription: null };
}

/**
 * Money given back on a purchase (refund or lost dispute): record it against
 * webstore revenue and the finance ledger, and for a full reversal of a
 * one-time purchase mark it refunded and revoke what it granted.
 * Subscriptions are not revoked here — cancelling the subscription in Stripe
 * fires customer.subscription.deleted, which revokes.
 */
async function reversePurchasePayment({ purchase, amountCents, currency, stripeRef, fullReversal, reason, config }) {
  if (amountCents > 0) {
    await createRefundTransaction({ purchase, amountCents, currency, stripeRef });

    try {
      const account = await getDefaultWebstoreAccount();
      if (account) {
        const recipient = purchase.recipientMinecraftUsername || purchase.purchaserMinecraftUsername || "unknown";
        await createTransaction({
          type: "expense",
          amountCents,
          currency: currency || "USD",
          accountId: account.accountId,
          description: `${reason}: ${purchase.itemName} — ${recipient}`,
          notes: `Webstore ${reason.toLowerCase()} for purchase #${purchase.purchaseId} (${stripeRef}).`,
          transactionDate: new Date().toISOString().slice(0, 10),
          createdByUserId: 0,
          externalRef: `webstore:${stripeRef}`,
        });
      }
    } catch (err) {
      console.error(`[webstore] Failed to record ${reason.toLowerCase()} in finance ledger for purchase`, purchase.purchaseId, err.message);
    }
  }

  let revokeCount = 0;
  if (fullReversal && purchase.purchaseType === "one_time" && purchase.status !== "refunded") {
    // Revoke before flipping the status, so a failure part-way is retried
    // (repeating a revoke is harmless; skipping one is not).
    const { revokeCommands } = await getCommandsByPriceId(purchase.itemSlug);
    revokeCount = revokeCommands.length;
    if (revokeCommands.length > 0) {
      await revokePurchase(purchase, revokeCommands, { discordClient, guildId: config?.discord?.guildId });
    }
    await updatePurchaseStatus(purchase.purchaseId, "refunded");
  }

  await notifyWebstore(
    config,
    `↩️ Webstore ${reason}`,
    [
      ["Package", purchase.itemName, false],
      ["Player", purchase.recipientMinecraftUsername, true],
      ["Amount", `${String(currency || "usd").toUpperCase()} ${(amountCents / 100).toFixed(2)}`, true],
      ["Purchase", `#${purchase.purchaseId}`, true],
      ["Revoke commands", fullReversal && purchase.purchaseType === "one_time" ? String(revokeCount) : "—", true],
    ],
    Colors.Orange
  );
}

// ---------------------------------------------------------------------------
// Handler: charge.refunded
// Fires on every full or partial refund; amount_refunded is cumulative.
// ---------------------------------------------------------------------------

async function handleChargeRefunded(event, config) {
  const charge = event.data.object;
  const { purchase } = await resolvePurchaseForCharge({
    paymentIntentId: typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id,
    invoiceId: typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id,
  });

  if (!purchase) {
    await recordWebhookEvent({
      stripeEventId: event.id,
      purchaseId: null,
      eventType: event.type,
      payload: { chargeId: charge.id, matched: false },
    });
    return;
  }

  // Record only what is new since the last refund event for this charge.
  const refundedTotal = Number(charge.amount_refunded) || 0;
  const alreadyRecorded = await getRecordedRefundCentsForCharge(charge.id);
  const delta = Math.max(refundedTotal - alreadyRecorded, 0);

  await reversePurchasePayment({
    purchase,
    amountCents: delta,
    currency: String(charge.currency || purchase.currency || "usd").toLowerCase(),
    stripeRef: `refund:${charge.id}:${refundedTotal}`,
    fullReversal: charge.refunded === true,
    reason: "Refund",
    config,
  });

  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: purchase.purchaseId,
    eventType: event.type,
    payload: { chargeId: charge.id, amount_refunded: refundedTotal, recorded: delta, full: charge.refunded === true },
  });
}

// ---------------------------------------------------------------------------
// Handlers: charge.dispute.created / charge.dispute.closed
// The disputed amount is only treated as lost once the dispute closes as lost.
// ---------------------------------------------------------------------------

async function resolvePurchaseForDispute(dispute) {
  const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  const byIntent = await getPurchaseByPaymentIntentId(paymentIntentId);
  if (byIntent) return byIntent;

  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
  if (!chargeId) return null;
  const charge = await fetchStripeCharge(chargeId);
  const { purchase } = await resolvePurchaseForCharge({
    paymentIntentId: null,
    invoiceId: typeof charge?.invoice === "string" ? charge.invoice : charge?.invoice?.id,
  });
  return purchase;
}

async function handleDisputeCreated(event, config) {
  const dispute = event.data.object;
  const purchase = await resolvePurchaseForDispute(dispute);

  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: purchase?.purchaseId || null,
    eventType: event.type,
    payload: { disputeId: dispute.id, reason: dispute.reason, amount: dispute.amount },
  });

  if (purchase) {
    await notifyWebstore(
      config,
      "⚠️ Chargeback Opened",
      [
        ["Package", purchase.itemName, false],
        ["Player", purchase.recipientMinecraftUsername, true],
        ["Amount", `${String(dispute.currency || "usd").toUpperCase()} ${((Number(dispute.amount) || 0) / 100).toFixed(2)}`, true],
        ["Reason", dispute.reason || "unknown", true],
        ["Purchase", `#${purchase.purchaseId}`, true],
      ],
      Colors.Red
    );
  }
}

async function handleDisputeClosed(event, config) {
  const dispute = event.data.object;
  const purchase = dispute.status === "lost" ? await resolvePurchaseForDispute(dispute) : null;

  if (purchase) {
    await reversePurchasePayment({
      purchase,
      amountCents: Number(dispute.amount) || 0,
      currency: String(dispute.currency || purchase.currency || "usd").toLowerCase(),
      stripeRef: `dispute:${dispute.id}`,
      fullReversal: true,
      reason: "Chargeback",
      config,
    });
  }

  await recordWebhookEvent({
    stripeEventId: event.id,
    purchaseId: purchase?.purchaseId || null,
    eventType: event.type,
    payload: { disputeId: dispute.id, status: dispute.status, amount: dispute.amount },
  });
}
