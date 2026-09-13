/**
 * routes/dashboard/finance.js
 *
 * Dashboard routes for the Finance Management module.
 *
 * All GET routes render EJS views.
 * All POST routes validate, call controller functions, set banner cookies and redirect.
 *
 * Permission nodes:
 *   zander.web.finance         — view access
 *   zander.web.finance.manage  — create / edit / delete access
 */

import { hasPermission, setBannerCookie } from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";

import {
  // Categories
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  // Transactions
  getTransactions,
  getTransactionCount,
  getTransactionById,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  // Budget
  getAllBudgetEntries,
  createBudgetEntry,
  updateBudgetEntry,
  deleteBudgetEntry,
  getBudgetVsActual,
  upsertMonthlyBudgetOverride,
  resetMonthlyBudgetOverride,
  createOneOffBudgetItem,
  deleteMonthlyBudgetItem,
  // Accounts & reconciliation
  getAccounts,
  createAccount,
  updateAccount,
  getAccountsWithReconciliation,
  setAccountBalance,
  getAccountBalanceHistory,
  deleteAccountBalance,
  // Dashboard
  getFinanceDashboardData,
  getFinanceMonthlyGoalCents,
  buildPublicFinanceSnapshot,
  getFinanceReportRecord,
  getPublishedFinanceReports,
  publishFinanceMonthlyReport,
  lockFinanceMonthlyReport,
  // Helpers
  centsToDisplay,
} from "../../controllers/financeController.js";

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

function canManageFinance(req) {
  const perms = req.session?.user?.permissions ?? [];
  return perms.some((p) => {
    const c = String(p).trim().toLowerCase();
    return c === "*" || c === "zander.web.finance.manage" || c === "zander.web.finance.*";
  });
}

// ---------------------------------------------------------------------------
// View data helper — builds the base object every finance view needs
// ---------------------------------------------------------------------------

async function baseViewData(req, features) {
  const [announcementWeb] = await Promise.all([getWebAnnouncement()]);
  return {
    ...adminViewData(req, features),
    announcementWeb,
    canManage: canManageFinance(req),
    centsToDisplay,
  };
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

function getPagination(query, defaultLimit = 50) {
  const limit = Math.min(parseInt(query.limit, 10) || defaultLimit, 200);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const offset = (page - 1) * limit;
  return { limit, page, offset };
}

// =============================================================================
// Route registrations
// =============================================================================

export default function dashboardFinanceRoute(app, fetch, config, db, features, lang) {

  function redirectRetiredFinanceSection(res) {
    setBannerCookie("info", "This finance section has been folded into the main Finance page.", res);
    return res.redirect("/dashboard/finance");
  }

  // ===========================================================================
  // GET /dashboard/finance — dashboard overview
  // ===========================================================================
  app.get("/dashboard/finance", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;

    try {
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth() + 1;
      const selectedYear = parseInt(req.query.year, 10) || currentYear;
      const selectedMonth = parseInt(req.query.month, 10) || currentMonth;

      // Reconcile balances as of the end of the selected month, but never past
      // today (a future month-end just means "as of now").
      const selectedMonthEnd = new Date(selectedYear, selectedMonth, 0, 23, 59, 59, 999);
      const reconcileAsOf = selectedMonthEnd > now ? now : selectedMonthEnd;

      const [base, dashData, categories, budgetSummary, accountReconciliation] = await Promise.all([
        baseViewData(req, features),
        getFinanceDashboardData(),
        getCategories(),
        getBudgetVsActual(selectedYear, selectedMonth),
        getAccountsWithReconciliation({ asOf: reconcileAsOf }).catch((err) => {
          console.error("[finance] account reconciliation load failed:", err.message);
          return [];
        }),
      ]);

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("dashboard/finance/index", {
          pageTitle: "Dashboard - Finance",
          config,
          req,
          features,
          ...base,
          ...dashData,
          budgetSummary,
          categories,
          accountReconciliation,
          reconcileAsOf,
          currentYear,
          currentMonth,
          selectedYear,
          selectedMonth,
        })
      );
    } catch (error) {
      console.error("[finance] GET /dashboard/finance:", error);
      setBannerCookie("danger", error.message, res);
      return res.redirect("/dashboard");
    }
  });

  // ===========================================================================
  // Accounts & balance reconciliation
  // ===========================================================================

  function backToFinance(req, res) {
    const { year, month } = req.body || {};
    const qs =
      year && month
        ? `?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`
        : "";
    return res.redirect(`/dashboard/finance${qs}#accounts`);
  }

  // POST /dashboard/finance/accounts/create
  app.post("/dashboard/finance/accounts/create", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to manage finance accounts.", res);
      return backToFinance(req, res);
    }
    try {
      const { name, accountType, currency, openingBalanceCents, notes } = req.body || {};
      await createAccount({ name, accountType, currency, openingBalanceCents, notes });
      setBannerCookie("success", "Account created.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/accounts/create:", error);
      setBannerCookie("danger", error.message, res);
    }
    return backToFinance(req, res);
  });

  // POST /dashboard/finance/accounts/:accountId/edit
  app.post("/dashboard/finance/accounts/:accountId/edit", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to manage finance accounts.", res);
      return backToFinance(req, res);
    }
    const accountId = parseInt(req.params.accountId, 10);
    if (!accountId) return backToFinance(req, res);
    try {
      const { name, accountType, currency, openingBalanceCents, notes, isActive } = req.body || {};
      await updateAccount(accountId, {
        name, accountType, currency, openingBalanceCents, notes,
        isActive: isActive === "1" || isActive === "on" ? 1 : 0,
      });
      setBannerCookie("success", "Account updated.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/accounts/:accountId/edit:", error);
      setBannerCookie("danger", error.message, res);
    }
    return backToFinance(req, res);
  });

  // POST /dashboard/finance/accounts/:accountId/balance — record a statement balance
  app.post("/dashboard/finance/accounts/:accountId/balance", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to reconcile finance accounts.", res);
      return backToFinance(req, res);
    }
    const accountId = parseInt(req.params.accountId, 10);
    if (!accountId) return backToFinance(req, res);
    try {
      const { asOfDate, balanceCents, note, source } = req.body || {};
      await setAccountBalance({
        accountId,
        asOfDate,
        balanceCents,
        note,
        source,
        createdByUserId: req.session?.user?.userId || 0,
      });
      setBannerCookie("success", "Balance recorded.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/accounts/:accountId/balance:", error);
      setBannerCookie("danger", error.message, res);
    }
    return backToFinance(req, res);
  });

  // POST /dashboard/finance/accounts/balance/:balanceId/delete
  app.post("/dashboard/finance/accounts/balance/:balanceId/delete", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to reconcile finance accounts.", res);
      return backToFinance(req, res);
    }
    try {
      await deleteAccountBalance(req.params.balanceId);
      setBannerCookie("success", "Balance record deleted.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/accounts/balance/:balanceId/delete:", error);
      setBannerCookie("danger", error.message, res);
    }
    return backToFinance(req, res);
  });

  // GET /dashboard/finance/accounts/:accountId/history — JSON balance history
  app.get("/dashboard/finance/accounts/:accountId/history", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    try {
      const history = await getAccountBalanceHistory(req.params.accountId, req.query.limit);
      return res.send({ success: true, history });
    } catch (error) {
      console.error("[finance] GET /dashboard/finance/accounts/:accountId/history:", error);
      return res.status(500).send({ success: false, message: error.message });
    }
  });

  // POST /dashboard/finance/budget/override — set/update this month's amount
  // for a template line item, without touching the template itself.
  app.post("/dashboard/finance/budget/override", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;

    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to manage budget entries.", res);
      return res.redirect("/dashboard/finance");
    }

    const { year, month, budgetItemId, monthlyBudgetCents } = req.body || {};
    try {
      await upsertMonthlyBudgetOverride({ year, month, budgetItemId, monthlyBudgetCents });
      setBannerCookie("success", "Budget override saved for this month.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/budget/override:", error);
      setBannerCookie("danger", error.message, res);
    }
    return res.redirect(`/dashboard/finance?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
  });

  // POST /dashboard/finance/budget/override/reset — revert a line item back
  // to the template amount for this month (deletes the override row).
  app.post("/dashboard/finance/budget/override/reset", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;

    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to manage budget entries.", res);
      return res.redirect("/dashboard/finance");
    }

    const { year, month, budgetItemId } = req.body || {};
    try {
      await resetMonthlyBudgetOverride(year, month, budgetItemId);
      setBannerCookie("success", "Reverted to the template amount for this month.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/budget/override/reset:", error);
      setBannerCookie("danger", error.message, res);
    }
    return res.redirect(`/dashboard/finance?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
  });

  // POST /dashboard/finance/budget/one-off/create — add a line item that
  // only exists for this specific month, not part of the standing template.
  app.post("/dashboard/finance/budget/one-off/create", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;

    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to manage budget entries.", res);
      return res.redirect("/dashboard/finance");
    }

    const { year, month, categoryId, label, publicDescription, monthlyBudgetCents, currency, iconName, iconImageUrl, notes } = req.body || {};
    try {
      await createOneOffBudgetItem({ year, month, categoryId, label, publicDescription, monthlyBudgetCents, currency, iconName, iconImageUrl, notes });
      setBannerCookie("success", "One-off budget item added.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/budget/one-off/create:", error);
      setBannerCookie("danger", error.message, res);
    }
    return res.redirect(`/dashboard/finance?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
  });

  // POST /dashboard/finance/budget/one-off/:id/delete
  app.post("/dashboard/finance/budget/one-off/:id/delete", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;

    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to manage budget entries.", res);
      return res.redirect("/dashboard/finance");
    }

    const { year, month } = req.body || {};
    try {
      await deleteMonthlyBudgetItem(req.params.id);
      setBannerCookie("success", "One-off budget item deleted.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/budget/one-off/:id/delete:", error);
      setBannerCookie("danger", error.message, res);
    }
    return res.redirect(`/dashboard/finance?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
  });

  // POST /dashboard/finance/budget/create
  app.post("/dashboard/finance/budget/create", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;

    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to manage budget entries.", res);
      return res.redirect("/dashboard/finance");
    }

    try {
      const { categoryId, label, publicDescription, monthlyBudgetCents, currency, cadence, annualMonth, iconName, iconImageUrl, notes } = req.body || {};
      await createBudgetEntry({ categoryId, label, publicDescription, monthlyBudgetCents, currency, cadence, annualMonth, iconName, iconImageUrl, notes });
      setBannerCookie("success", "Budget entry created.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/budget/create:", error);
      setBannerCookie("danger", error.message, res);
    }
    return res.redirect("/dashboard/finance");
  });

  // POST /dashboard/finance/budget/:budgetId/edit
  app.post("/dashboard/finance/budget/:budgetId/edit", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;

    const budgetId = parseInt(req.params.budgetId, 10);
    if (!budgetId) return res.redirect("/dashboard/finance");

    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to manage budget entries.", res);
      return res.redirect("/dashboard/finance");
    }

    try {
      const { categoryId, label, publicDescription, monthlyBudgetCents, currency, cadence, annualMonth, iconName, iconImageUrl, notes, isActive } = req.body || {};
      await updateBudgetEntry(budgetId, {
        categoryId, label, publicDescription, monthlyBudgetCents, currency, cadence, annualMonth, iconName, iconImageUrl, notes,
        isActive: isActive === "1" ? 1 : 0,
      });
      setBannerCookie("success", "Budget entry updated.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/budget/:budgetId/edit:", error);
      setBannerCookie("danger", error.message, res);
    }
    return res.redirect("/dashboard/finance");
  });

  // POST /dashboard/finance/budget/:budgetId/delete
  app.post("/dashboard/finance/budget/:budgetId/delete", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;

    const budgetId = parseInt(req.params.budgetId, 10);
    if (!budgetId) return res.redirect("/dashboard/finance");

    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to manage budget entries.", res);
      return res.redirect("/dashboard/finance");
    }

    try {
      await deleteBudgetEntry(budgetId);
      setBannerCookie("success", "Budget entry deleted.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/budget/:budgetId/delete:", error);
      setBannerCookie("danger", error.message, res);
    }
    return res.redirect("/dashboard/finance");
  });

  // ===========================================================================
  // Transactions
  // ===========================================================================

  // GET /dashboard/finance/transactions
  app.get("/dashboard/finance/transactions", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    return redirectRetiredFinanceSection(res);
  });

  // GET /dashboard/finance/transactions/create
  app.get("/dashboard/finance/transactions/create", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    return redirectRetiredFinanceSection(res);
  });

  // POST /dashboard/finance/transactions/create
  app.post("/dashboard/finance/transactions/create", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    return redirectRetiredFinanceSection(res);
  });

  // GET /dashboard/finance/transactions/:transactionId/edit
  app.get("/dashboard/finance/transactions/:transactionId/edit", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    return redirectRetiredFinanceSection(res);
  });

  // POST /dashboard/finance/transactions/:transactionId/edit
  app.post("/dashboard/finance/transactions/:transactionId/edit", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    return redirectRetiredFinanceSection(res);
  });

  // POST /dashboard/finance/transactions/:transactionId/delete
  app.post("/dashboard/finance/transactions/:transactionId/delete", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    return redirectRetiredFinanceSection(res);
  });

  // ===========================================================================
  // Budget
  // ===========================================================================

  // GET /dashboard/finance/budget — no dedicated page; budget management now
  // lives inline on the main Finance page.
  app.get("/dashboard/finance/budget", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    return redirectRetiredFinanceSection(res);
  });

  // ===========================================================================
  // Reports
  // ===========================================================================

  app.get("/dashboard/finance/reports", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;

    try {
      const now = new Date();
      const selectedYear = parseInt(req.query.year, 10) || now.getFullYear();
      const selectedMonth = parseInt(req.query.month, 10) || now.getMonth() + 1;
      const monthlyGoalCents = getFinanceMonthlyGoalCents(config);

      const [base, existingReport, publishedReports, previewData] = await Promise.all([
        baseViewData(req, features),
        getFinanceReportRecord(selectedYear, selectedMonth),
        getPublishedFinanceReports(12),
        req.query.preview === "1"
          ? buildPublicFinanceSnapshot({
            year: selectedYear,
            month: selectedMonth,
            monthlyGoalCents,
            publicNote: req.query.publicNote || null,
          })
          : null,
      ]);

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("dashboard/finance/reports", {
          pageTitle: "Finance - Reports",
          config,
          req,
          features,
          ...base,
          selectedYear,
          selectedMonth,
          monthlyGoalCents,
          existingReport,
          publishedReports,
          previewData,
        })
      );
    } catch (error) {
      console.error("[finance] GET /dashboard/finance/reports:", error);
      setBannerCookie("danger", error.message, res);
      return res.redirect("/dashboard/finance");
    }
  });

  app.post("/dashboard/finance/reports/publish", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to publish finance reports.", res);
      return res.redirect("/dashboard/finance/reports");
    }

    try {
      const { year, month, publicNote } = req.body || {};
      await publishFinanceMonthlyReport({
        year,
        month,
        monthlyGoalCents: getFinanceMonthlyGoalCents(config),
        publicNote,
        publishedByUserId: req.session?.user?.userId || 0,
      });
      setBannerCookie("success", "Finance report published.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/reports/publish:", error);
      setBannerCookie("danger", error.message, res);
    }

    return res.redirect(`/dashboard/finance/reports?year=${encodeURIComponent(req.body?.year || "")}&month=${encodeURIComponent(req.body?.month || "")}`);
  });

  app.post("/dashboard/finance/reports/lock", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to lock finance reports.", res);
      return res.redirect("/dashboard/finance/reports");
    }

    try {
      const { year, month } = req.body || {};
      await lockFinanceMonthlyReport(year, month);
      setBannerCookie("success", "Finance report locked.", res);
    } catch (error) {
      console.error("[finance] POST /dashboard/finance/reports/lock:", error);
      setBannerCookie("danger", error.message, res);
    }

    return res.redirect(`/dashboard/finance/reports?year=${encodeURIComponent(req.body?.year || "")}&month=${encodeURIComponent(req.body?.month || "")}`);
  });

  // ===========================================================================
  // Settings (categories only)
  // ===========================================================================

  // GET /dashboard/finance/settings
  app.get("/dashboard/finance/settings", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;

    if (!canManageFinance(req)) {
      setBannerCookie("danger", "You do not have permission to access finance settings.", res);
      return res.redirect("/dashboard/finance");
    }

    try {
      const [base, categories] = await Promise.all([
        baseViewData(req, features),
        getCategories(),
      ]);

      res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("dashboard/finance/settings", {
          pageTitle: "Finance - Settings",
          config,
          req,
          features,
          ...base,
          categories,
        })
      );
    } catch (error) {
      console.error("[finance] GET /dashboard/finance/settings:", error);
      setBannerCookie("danger", error.message, res);
      return res.redirect("/dashboard/finance");
    }
  });

  // ---- Categories ----

  app.post("/dashboard/finance/settings/categories/create", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    if (!canManageFinance(req)) {
      setBannerCookie("danger", "Permission denied.", res);
      return res.redirect("/dashboard/finance/settings");
    }
    try {
      const { parentId, name, type, color } = req.body || {};
      await createCategory({ parentId, name, type, color });
      setBannerCookie("success", "Category created.", res);
    } catch (error) {
      console.error("[finance] POST settings/categories/create:", error);
      setBannerCookie("danger", error.message, res);
    }
    return res.redirect("/dashboard/finance/settings");
  });

  app.post("/dashboard/finance/settings/categories/:id/edit", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    if (!canManageFinance(req)) {
      setBannerCookie("danger", "Permission denied.", res);
      return res.redirect("/dashboard/finance/settings");
    }
    const id = parseInt(req.params.id, 10);
    try {
      const {
        parentId,
        name,
        type,
        color,
        isActive,
        isPublic,
        publicName,
        publicDescription,
        publicSortOrder,
      } = req.body || {};
      await updateCategory(id, {
        parentId,
        name,
        type,
        color,
        isActive: isActive === "1" ? 1 : 0,
        isPublic: isPublic === "1" ? 1 : 0,
        publicName,
        publicDescription,
        publicSortOrder,
      });
      setBannerCookie("success", "Category updated.", res);
    } catch (error) {
      console.error("[finance] POST settings/categories/:id/edit:", error);
      setBannerCookie("danger", error.message, res);
    }
    return res.redirect("/dashboard/finance/settings");
  });

  app.post("/dashboard/finance/settings/categories/:id/delete", async function (req, res) {
    if (!await hasPermission("zander.web.finance", req, res, features)) return;
    if (!canManageFinance(req)) {
      setBannerCookie("danger", "Permission denied.", res);
      return res.redirect("/dashboard/finance/settings");
    }
    const id = parseInt(req.params.id, 10);
    try {
      await deleteCategory(id);
      setBannerCookie("success", "Category deleted.", res);
    } catch (error) {
      console.error("[finance] POST settings/categories/:id/delete:", error);
      setBannerCookie("danger", error.message, res);
    }
    return res.redirect("/dashboard/finance/settings");
  });

}
