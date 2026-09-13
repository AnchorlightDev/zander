-- =============================================================================
-- Migration 0011: Webstore module
-- =============================================================================
-- Tables:
--   webstorePurchases       — one row per Stripe checkout session / order
--   webstoreSubscriptions   — active subscription lifecycle tracking
--   webstoreWebhookEvents   — idempotency log for Stripe webhook events
--   webstoreStripeCommands  — maps Stripe price IDs to in-game command templates
--   webstoreCommandRuns     — individual command execution records
--   webstoreTransactions    — audit ledger for all completed payments
-- =============================================================================

-- One record per Stripe checkout session.  Created when the user is sent to
-- Stripe, then updated by webhooks as the payment progresses.
CREATE TABLE `webstorePurchases` (
    `purchaseId`                   INT          NOT NULL AUTO_INCREMENT,
    `userId`                       INT          NOT NULL,
    `itemSlug`                     VARCHAR(120) NOT NULL COMMENT 'Stripe price ID',
    `itemName`                     VARCHAR(180) NOT NULL,
    `purchaseType`                 ENUM('one_time','subscription') NOT NULL,
    `purchaserMinecraftUsername`   VARCHAR(16)  NOT NULL,
    `recipientMinecraftUsername`   VARCHAR(16)  NOT NULL,
    `status`                       ENUM('pending','paid','fulfilled','failed','refunded') NOT NULL DEFAULT 'pending',
    `stripeSessionId`              VARCHAR(255) NOT NULL,
    `stripePaymentIntentId`        VARCHAR(255) NULL,
    `stripeSubscriptionId`         VARCHAR(255) NULL,
    `stripeCustomerId`             VARCHAR(255) NULL,
    `amountCents`                  INT          NOT NULL,
    `currency`                     VARCHAR(10)  NOT NULL,
    `isGift`                       TINYINT(1)   NOT NULL DEFAULT 0,
    `createdAt`                    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`                    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`purchaseId`),
    UNIQUE KEY `webstorePurchases_session`       (`stripeSessionId`),
    INDEX       `webstorePurchases_user`         (`userId`),
    INDEX       `webstorePurchases_status`       (`status`),
    INDEX       `webstorePurchases_subscription` (`stripeSubscriptionId`),
    CONSTRAINT  `fk_webstorePurchases_users`
        FOREIGN KEY (`userId`) REFERENCES `users`(`userId`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tracks the lifecycle of every active subscription.
-- Renewed and updated by webhook events throughout the subscription lifetime.
CREATE TABLE `webstoreSubscriptions` (
    `subscriptionId`               INT          NOT NULL AUTO_INCREMENT,
    `purchaseId`                   INT          NOT NULL,
    `stripeSubscriptionId`         VARCHAR(255) NOT NULL,
    `stripeCustomerId`             VARCHAR(255) NULL,
    `stripePriceId`                VARCHAR(120) NOT NULL,
    `recipientMinecraftUsername`   VARCHAR(16)  NOT NULL,
    `purchaserMinecraftUsername`   VARCHAR(16)  NOT NULL,
    `purchaserUserId`              INT          NOT NULL,
    `status`                       ENUM('active','past_due','cancelled','expired','unpaid') NOT NULL DEFAULT 'active',
    `currentPeriodStart`           DATETIME     NULL,
    `currentPeriodEnd`             DATETIME     NULL,
    `cancelAtPeriodEnd`            TINYINT(1)   NOT NULL DEFAULT 0,
    `cancelledAt`                  DATETIME     NULL,
    `createdAt`                    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`                    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`subscriptionId`),
    UNIQUE KEY `webstoreSubscriptions_stripe`    (`stripeSubscriptionId`),
    INDEX       `webstoreSubscriptions_purchase` (`purchaseId`),
    INDEX       `webstoreSubscriptions_recipient`(`recipientMinecraftUsername`),
    INDEX       `webstoreSubscriptions_status`   (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Idempotency log.  Each Stripe event ID is written here before processing
-- begins.  Duplicate deliveries are detected via the UNIQUE key and ignored.
CREATE TABLE `webstoreWebhookEvents` (
    `webhookEventId`  INT          NOT NULL AUTO_INCREMENT,
    `stripeEventId`   VARCHAR(255) NOT NULL,
    `purchaseId`      INT          NULL,
    `eventType`       VARCHAR(80)  NOT NULL,
    `payload`         JSON         NULL,
    `processedAt`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`webhookEventId`),
    UNIQUE KEY `webstoreWebhookEvents_event`    (`stripeEventId`),
    INDEX      `webstoreWebhookEvents_purchase` (`purchaseId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Maps Stripe price IDs to the in-game command templates that should run
-- when a purchase is fulfilled.
--
-- action = 'grant'  → run on initial purchase and on every subscription renewal
-- action = 'revoke' → run when a subscription is cancelled or expires
--
-- Templates may contain {{ username }}, {{ purchaserUsername }},
-- {{ purchaseId }}, {{ itemSlug }}, {{ purchaseType }}, {{ isGift }}.
CREATE TABLE `webstoreStripeCommands` (
    `commandId`       INT          NOT NULL AUTO_INCREMENT,
    `stripePriceId`   VARCHAR(120) NOT NULL,
    `action`          ENUM('grant','revoke') NOT NULL DEFAULT 'grant',
    `commandTemplate` TEXT         NOT NULL,
    `sortOrder`       INT          NOT NULL DEFAULT 0,
    `createdAt`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`commandId`),
    INDEX `webstoreStripeCommands_price`  (`stripePriceId`),
    INDEX `webstoreStripeCommands_action` (`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tracks each individual command execution that was dispatched to executorTasks.
CREATE TABLE `webstoreCommandRuns` (
    `commandRunId`         INT          NOT NULL AUTO_INCREMENT,
    `purchaseId`           INT          NOT NULL,
    `stripeSubscriptionId` VARCHAR(255) NULL     COMMENT 'Set for subscription renewal runs',
    `action`               ENUM('grant','revoke') NOT NULL DEFAULT 'grant',
    `commandTemplate`      TEXT         NOT NULL,
    `resolvedCommand`      TEXT         NOT NULL,
    `executorTaskId`       INT          NULL,
    `status`               ENUM('queued','processing','completed','failed') NOT NULL DEFAULT 'queued',
    `attempts`             INT          NOT NULL DEFAULT 0,
    `lastError`            TEXT         NULL,
    `createdAt`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`commandRunId`),
    INDEX `webstoreCommandRuns_purchase` (`purchaseId`),
    INDEX `webstoreCommandRuns_executor` (`executorTaskId`),
    INDEX `webstoreCommandRuns_status`   (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit ledger for all completed payments.  Records both sides of a
-- transaction (outgoing for the purchaser, incoming for a gift recipient
-- who has a registered account).
CREATE TABLE `webstoreTransactions` (
    `transactionId`                INT          NOT NULL AUTO_INCREMENT,
    `purchaseId`                   INT          NOT NULL,
    `userId`                       INT          NOT NULL,
    `direction`                    ENUM('incoming','outgoing') NOT NULL,
    `counterpartyMinecraftUsername` VARCHAR(16)  NOT NULL,
    `amountCents`                  INT          NOT NULL,
    `currency`                     VARCHAR(10)  NOT NULL,
    `createdAt`                    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`transactionId`),
    INDEX `webstoreTransactions_user`     (`userId`),
    INDEX `webstoreTransactions_purchase` (`purchaseId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
