-- =============================================================================
-- Migration 0018: Finance Management module
-- =============================================================================
-- Tables (in dependency order):
--   financeAccounts           — bank/payment accounts
--   financeCategories         — hierarchical income/expense categories
--   financeTags               — free-form transaction tags
--   financeVendors            — suppliers / vendors
--   financeTransactions       — individual income, expense and transfer records
--   financeTransactionTags    — many-to-many: transactions ↔ tags
--   financeInvoices           — vendor invoices
--   financePayments           — payments against invoices or ad-hoc
--   financeAttachments        — file attachments (PDFs etc.) for any entity
--   financeOperationsBudget   — monthly budget targets per vendor/category
--   financeMonthlyReports     — published monthly summary reports
-- =============================================================================

-- Bank accounts and payment accounts that money flows in/out of.
CREATE TABLE `financeAccounts` (
    `accountId`             INT          NOT NULL AUTO_INCREMENT,
    `name`                  VARCHAR(150) NOT NULL,
    `accountType`           ENUM('bank','credit_card','paypal','stripe','crypto','other') NOT NULL DEFAULT 'bank',
    `openingBalanceCents`   INT          NOT NULL DEFAULT 0,
    `currency`              VARCHAR(3)   NOT NULL DEFAULT 'USD',
    `isActive`              TINYINT(1)   NOT NULL DEFAULT 1,
    `notes`                 TEXT         NULL,
    `createdAt`             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`accountId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Hierarchical income/expense categories.  parentId is self-referencing.
CREATE TABLE `financeCategories` (
    `categoryId`  INT         NOT NULL AUTO_INCREMENT,
    `parentId`    INT         NULL,
    `name`        VARCHAR(100) NOT NULL,
    `type`        ENUM('income','expense') NOT NULL DEFAULT 'expense',
    `color`       VARCHAR(7)  NOT NULL DEFAULT '#6c757d',
    `isActive`    TINYINT(1)  NOT NULL DEFAULT 1,
    `createdAt`   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`categoryId`),
    INDEX `financeCategories_parent` (`parentId`),
    CONSTRAINT `fk_financeCategories_parent`
        FOREIGN KEY (`parentId`) REFERENCES `financeCategories`(`categoryId`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Free-form tags that can be attached to transactions.
CREATE TABLE `financeTags` (
    `tagId`     INT         NOT NULL AUTO_INCREMENT,
    `name`      VARCHAR(60) NOT NULL,
    `color`     VARCHAR(7)  NOT NULL DEFAULT '#0d6efd',
    `createdAt` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`tagId`),
    UNIQUE KEY `financeTags_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vendors / suppliers that money is paid to or received from.
CREATE TABLE `financeVendors` (
    `vendorId`         INT          NOT NULL AUTO_INCREMENT,
    `name`             VARCHAR(150) NOT NULL,
    `website`          VARCHAR(255) NULL,
    `contactEmail`     VARCHAR(180) NULL,
    `notes`            TEXT         NULL,
    `categoryId`       INT          NULL,
    `faviconUrl`       VARCHAR(500) NULL,
    `logoUrl`          VARCHAR(500) NULL,
    `logoPublicId`     VARCHAR(255) NULL,
    `isActive`         TINYINT(1)   NOT NULL DEFAULT 1,
    `faviconFetchedAt` DATETIME     NULL,
    `createdAt`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`vendorId`),
    INDEX `financeVendors_category`  (`categoryId`),
    CONSTRAINT `fk_financeVendors_category`
        FOREIGN KEY (`categoryId`) REFERENCES `financeCategories`(`categoryId`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Individual income, expense and transfer transactions.
CREATE TABLE `financeTransactions` (
    `transactionId`   INT          NOT NULL AUTO_INCREMENT,
    `type`            ENUM('income','expense','transfer') NOT NULL DEFAULT 'expense',
    `amountCents`     INT          NOT NULL DEFAULT 0,
    `currency`        VARCHAR(3)   NOT NULL DEFAULT 'USD',
    `accountId`       INT          NOT NULL,
    `toAccountId`     INT          NULL,
    `categoryId`      INT          NULL,
    `vendorId`        INT          NULL,
    `description`     VARCHAR(500) NOT NULL DEFAULT '',
    `notes`           TEXT         NULL,
    `transactionDate` DATE         NOT NULL,
    `isLocked`        TINYINT(1)   NOT NULL DEFAULT 0,
    `createdByUserId` INT          NOT NULL,
    `createdAt`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`transactionId`),
    INDEX `financeTransactions_account`     (`accountId`),
    INDEX `financeTransactions_toAccount`   (`toAccountId`),
    INDEX `financeTransactions_category`    (`categoryId`),
    INDEX `financeTransactions_vendor`      (`vendorId`),
    INDEX `financeTransactions_date`        (`transactionDate`),
    INDEX `financeTransactions_type`        (`type`),
    INDEX `financeTransactions_locked`      (`isLocked`),
    CONSTRAINT `fk_financeTransactions_account`
        FOREIGN KEY (`accountId`) REFERENCES `financeAccounts`(`accountId`) ON DELETE RESTRICT,
    CONSTRAINT `fk_financeTransactions_toAccount`
        FOREIGN KEY (`toAccountId`) REFERENCES `financeAccounts`(`accountId`) ON DELETE SET NULL,
    CONSTRAINT `fk_financeTransactions_category`
        FOREIGN KEY (`categoryId`) REFERENCES `financeCategories`(`categoryId`) ON DELETE SET NULL,
    CONSTRAINT `fk_financeTransactions_vendor`
        FOREIGN KEY (`vendorId`) REFERENCES `financeVendors`(`vendorId`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Junction table linking transactions to tags (many-to-many).
CREATE TABLE `financeTransactionTags` (
    `id`            INT NOT NULL AUTO_INCREMENT,
    `transactionId` INT NOT NULL,
    `tagId`         INT NOT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `financeTransactionTags_unique` (`transactionId`, `tagId`),
    CONSTRAINT `fk_financeTransactionTags_transaction`
        FOREIGN KEY (`transactionId`) REFERENCES `financeTransactions`(`transactionId`) ON DELETE CASCADE,
    CONSTRAINT `fk_financeTransactionTags_tag`
        FOREIGN KEY (`tagId`) REFERENCES `financeTags`(`tagId`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vendor invoices — represent money owed to or from a vendor.
CREATE TABLE `financeInvoices` (
    `invoiceId`        INT          NOT NULL AUTO_INCREMENT,
    `vendorId`         INT          NOT NULL,
    `invoiceNumber`    VARCHAR(100) NOT NULL DEFAULT '',
    `issueDate`        DATE         NULL,
    `dueDate`          DATE         NULL,
    `amountCents`      INT          NOT NULL DEFAULT 0,
    `paidAmountCents`  INT          NOT NULL DEFAULT 0,
    `currency`         VARCHAR(3)   NOT NULL DEFAULT 'USD',
    `status`           ENUM('pending','partial','paid','overdue','cancelled') NOT NULL DEFAULT 'pending',
    `description`      TEXT         NULL,
    `createdByUserId`  INT          NOT NULL DEFAULT 0,
    `createdAt`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`invoiceId`),
    INDEX `financeInvoices_vendor` (`vendorId`),
    INDEX `financeInvoices_status` (`status`),
    INDEX `financeInvoices_due`    (`dueDate`),
    CONSTRAINT `fk_financeInvoices_vendor`
        FOREIGN KEY (`vendorId`) REFERENCES `financeVendors`(`vendorId`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Payments recorded against invoices or ad-hoc vendor payments.
CREATE TABLE `financePayments` (
    `paymentId`       INT      NOT NULL AUTO_INCREMENT,
    `vendorId`        INT      NOT NULL,
    `invoiceId`       INT      NULL,
    `transactionId`   INT      NULL,
    `accountId`       INT      NOT NULL,
    `amountCents`     INT      NOT NULL DEFAULT 0,
    `currency`        VARCHAR(3) NOT NULL DEFAULT 'USD',
    `paidDate`        DATE     NOT NULL,
    `notes`           TEXT     NULL,
    `createdByUserId` INT      NOT NULL DEFAULT 0,
    `createdAt`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`paymentId`),
    INDEX `financePayments_vendor`      (`vendorId`),
    INDEX `financePayments_invoice`     (`invoiceId`),
    INDEX `financePayments_transaction` (`transactionId`),
    INDEX `financePayments_account`     (`accountId`),
    INDEX `financePayments_date`        (`paidDate`),
    CONSTRAINT `fk_financePayments_vendor`
        FOREIGN KEY (`vendorId`) REFERENCES `financeVendors`(`vendorId`) ON DELETE RESTRICT,
    CONSTRAINT `fk_financePayments_invoice`
        FOREIGN KEY (`invoiceId`) REFERENCES `financeInvoices`(`invoiceId`) ON DELETE SET NULL,
    CONSTRAINT `fk_financePayments_transaction`
        FOREIGN KEY (`transactionId`) REFERENCES `financeTransactions`(`transactionId`) ON DELETE SET NULL,
    CONSTRAINT `fk_financePayments_account`
        FOREIGN KEY (`accountId`) REFERENCES `financeAccounts`(`accountId`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- File attachments (PDFs, images) for transactions, invoices, or vendors.
CREATE TABLE `financeAttachments` (
    `attachmentId`      INT          NOT NULL AUTO_INCREMENT,
    `transactionId`     INT          NULL,
    `invoiceId`         INT          NULL,
    `vendorId`          INT          NULL,
    `fileName`          VARCHAR(255) NOT NULL DEFAULT '',
    `fileUrl`           VARCHAR(500) NOT NULL DEFAULT '',
    `filePublicId`      VARCHAR(255) NOT NULL DEFAULT '',
    `mimeType`          VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
    `fileSizeBytes`     INT          NOT NULL DEFAULT 0,
    `label`             VARCHAR(100) NULL,
    `uploadedByUserId`  INT          NOT NULL DEFAULT 0,
    `createdAt`         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`attachmentId`),
    INDEX `financeAttachments_transaction` (`transactionId`),
    INDEX `financeAttachments_invoice`     (`invoiceId`),
    INDEX `financeAttachments_vendor`      (`vendorId`),
    CONSTRAINT `fk_financeAttachments_transaction`
        FOREIGN KEY (`transactionId`) REFERENCES `financeTransactions`(`transactionId`) ON DELETE CASCADE,
    CONSTRAINT `fk_financeAttachments_invoice`
        FOREIGN KEY (`invoiceId`) REFERENCES `financeInvoices`(`invoiceId`) ON DELETE CASCADE,
    CONSTRAINT `fk_financeAttachments_vendor`
        FOREIGN KEY (`vendorId`) REFERENCES `financeVendors`(`vendorId`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Monthly budget targets, optionally tied to a vendor or category.
CREATE TABLE `financeOperationsBudget` (
    `budgetId`            INT          NOT NULL AUTO_INCREMENT,
    `vendorId`            INT          NULL,
    `categoryId`          INT          NULL,
    `label`               VARCHAR(150) NOT NULL DEFAULT '',
    `monthlyBudgetCents`  INT          NOT NULL DEFAULT 0,
    `currency`            VARCHAR(3)   NOT NULL DEFAULT 'USD',
    `notes`               TEXT         NULL,
    `isActive`            TINYINT(1)   NOT NULL DEFAULT 1,
    `createdAt`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`budgetId`),
    INDEX `financeOperationsBudget_vendor`   (`vendorId`),
    INDEX `financeOperationsBudget_category` (`categoryId`),
    CONSTRAINT `fk_financeOperationsBudget_vendor`
        FOREIGN KEY (`vendorId`) REFERENCES `financeVendors`(`vendorId`) ON DELETE SET NULL,
    CONSTRAINT `fk_financeOperationsBudget_category`
        FOREIGN KEY (`categoryId`) REFERENCES `financeCategories`(`categoryId`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Published monthly financial summary reports.
CREATE TABLE `financeMonthlyReports` (
    `reportId`             INT        NOT NULL AUTO_INCREMENT,
    `year`                 SMALLINT   NOT NULL,
    `month`                TINYINT    NOT NULL,
    `totalIncomeCents`     INT        NOT NULL DEFAULT 0,
    `totalExpensesCents`   INT        NOT NULL DEFAULT 0,
    `netAmountCents`       INT        NOT NULL DEFAULT 0,
    `isPublished`          TINYINT(1) NOT NULL DEFAULT 0,
    `isLocked`             TINYINT(1) NOT NULL DEFAULT 0,
    `publishedAt`          DATETIME   NULL,
    `publishedByUserId`    INT        NULL,
    `notes`                TEXT       NULL,
    `reportData`           JSON       NULL,
    `createdAt`            DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt`            DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`reportId`),
    UNIQUE KEY `financeMonthlyReports_period`    (`year`, `month`),
    INDEX      `financeMonthlyReports_published` (`isPublished`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
