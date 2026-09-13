import { getGlobalImage } from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import {
  buildPublicFinanceSnapshot,
  getFinanceMonthlyGoalCents,
  getPublishedFinanceReportByMonth,
  getPublishedFinanceReports,
} from "../controllers/financeController.js";

async function renderNotFound(app, req, res, config, features) {
  return res.status(404).header("content-type", "text/html; charset=utf-8").send(
    await app.view("session/notFound", {
      pageTitle: "404 Not Found",
      config,
      req,
      features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
    })
  );
}

export default function financeRoutes(app, config, features) {
  app.get("/finance", async function (req, res) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthlyGoalCents = getFinanceMonthlyGoalCents(config);

    const [globalImage, announcementWeb, currentMonth, reports] = await Promise.all([
      getGlobalImage(),
      getWebAnnouncement(),
      buildPublicFinanceSnapshot({ year, month, monthlyGoalCents }),
      getPublishedFinanceReports(6),
    ]);

    return res.view("modules/finance/index", {
      pageTitle: "Finance Centre",
      pageDescription: `View how community support helps fund ${config.siteConfiguration.siteName}.`,
      config,
      req,
      features,
      globalImage,
      announcementWeb,
      currentMonth,
      reports,
    });
  });

  app.get("/finance/reports/:year/:month", async function (req, res) {
    const year = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10);

    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return renderNotFound(app, req, res, config, features);
    }

    const report = await getPublishedFinanceReportByMonth(year, month);
    if (!report) {
      return renderNotFound(app, req, res, config, features);
    }

    return res.view("modules/finance/report", {
      pageTitle: `${report.snapshot.monthLabel} Financial Report`,
      pageDescription: `View the ${report.snapshot.monthLabel} financial summary for ${config.siteConfiguration.siteName}.`,
      config,
      req,
      features,
      globalImage: await getGlobalImage(),
      announcementWeb: await getWebAnnouncement(),
      report,
    });
  });
}
