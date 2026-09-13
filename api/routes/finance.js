/**
 * api/routes/finance.js
 *
 * Finance module API routes.
 * Token-authenticated (handled by middleware — no per-route permission check needed).
 *
 *   GET  /api/finance/categories  — list categories
 *   GET  /api/finance/dashboard   — dashboard summary JSON
 */

import {
  getCategories,
  getFinanceDashboardData,
} from "../../controllers/financeController.js";

export default function financeApiRoute(app, config, db, features, lang) {

  // ===========================================================================
  // GET /api/finance/categories — list categories
  // ===========================================================================
  app.get("/api/finance/categories", async function (req, res) {
    try {
      const categories = await getCategories();
      return res.send({ success: true, data: categories });
    } catch (error) {
      console.error("[finance] GET /api/finance/categories:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error.message}` });
    }
  });

  // ===========================================================================
  // GET /api/finance/dashboard — dashboard summary JSON
  // ===========================================================================
  app.get("/api/finance/dashboard", async function (req, res) {
    try {
      const data = await getFinanceDashboardData();
      return res.send({ success: true, data });
    } catch (error) {
      console.error("[finance] GET /api/finance/dashboard:", error);
      if (!res.sent) return res.status(500).send({ success: false, message: `${error.message}` });
    }
  });

}
