/**
 * routes/dashboard/scheduler.js
 *
 * Unified scheduler dashboard. Jobs with ordered actions, a run history, and
 * read-only views of forum threads with a publishAt and announcement posts with
 * future windows. All routes call services in-process (no internal HTTP redirect).
 */
import { ChannelType } from "discord.js";
import {
  hasPermission,
  isFeatureWebRouteEnabled,
  generateLog,
} from "../../api/common.js";
import { adminViewData } from "../../admin/adminHelpers.js";
import { prisma } from "../../controllers/databaseController.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { listPosts } from "../../services/announcementPostService.js";
import { getWebstoreItems } from "../../controllers/webstoreController.js";
import {
  createJob,
  updateJob,
  deleteJob,
  getJob,
  listJobs,
  setJobEnabled,
  duplicateJob,
  listRuns,
  previewOccurrences,
  previewActions,
  validateJob,
} from "../../services/schedulerJobService.mjs";
import { runJobNow } from "../../services/schedulerRunner.mjs";

const NODE = "zander.web.scheduler";

export default function dashboardSchedulerSiteRoute(app, client, fetch, config, features, lang) {
  async function discordChannels() {
    const guildId = config.discord?.guildId ?? process.env.DISCORD_GUILD_ID;
    const out = [];
    if (guildId && client?.isReady?.()) {
      try {
        const guild = await client.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        channels.forEach((c) => {
          if (c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)) {
            out.push({ id: c.id, name: c.name });
          }
        });
      } catch (e) {
        console.error("[dashboard/scheduler] channel load failed:", e?.message || e);
      }
    }
    return out;
  }

  async function pickerData() {
    const [channels, forumDrafts, posts, routines, slugs, products] = await Promise.all([
      discordChannels(),
      prisma.forumDiscussions.findMany({
        where: { status: { in: ["draft", "scheduled"] } },
        select: { discussionId: true, title: true, status: true, publishAt: true },
        orderBy: { discussionId: "desc" },
        take: 200,
      }).catch(() => []),
      listPosts().catch(() => []),
      prisma.executorRoutines.findMany({ select: { routineSlug: true, displayName: true }, orderBy: { routineSlug: "asc" } }).catch(() => []),
      prisma.$queryRawUnsafe("SELECT DISTINCT slug FROM executorTasks ORDER BY slug ASC LIMIT 100").catch(() => []),
      // Live storefront products, so a webstore_visibility action can be built by
      // picking a product rather than pasting a Stripe price id. Stripe may be
      // down; the picker just comes back empty then.
      getWebstoreItems().catch(() => []),
    ]);
    return {
      channels,
      forumDrafts,
      posts: posts.map((p) => ({ postId: p.postId, title: p.title, status: p.status })),
      routines,
      serverSlugs: ["any", ...slugs.map((r) => r.slug).filter((s) => s && s !== "any")],
      products: products.map((p) => ({ stripePriceId: p.stripePriceId, displayName: p.displayName })),
    };
  }

  // ── Index: jobs + history + read-only tabs ──────────────────────────────────
  app.get("/dashboard/scheduler", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, true, req, res, features)) return;
    if (!await hasPermission(NODE, req, res, features)) return;

    const now = new Date();
    const [jobs, runs, forumScheduled, posts, announcementWeb] = await Promise.all([
      listJobs().catch(() => []),
      listRuns({ limit: 50 }).catch(() => []),
      prisma.forumDiscussions.findMany({
        where: { publishAt: { not: null } },
        select: { discussionId: true, title: true, status: true, publishAt: true, slug: true },
        orderBy: { publishAt: "asc" },
      }).catch(() => []),
      listPosts().catch(() => []),
      getWebAnnouncement(),
    ]);

    // Announcement posts with a future start or end.
    const futurePosts = posts.filter((p) =>
      p.platforms.some((r) => (r.startDate && new Date(r.startDate) > now) || (r.endDate && new Date(r.endDate) > now))
    );

    // Next run preview per job (in the job's tz + viewer local on the client).
    const jobsView = jobs.map((j) => ({ ...j, nextFew: previewOccurrences(j, 1).map((d) => d.toISOString()) }));

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/scheduler/scheduler-index", {
        pageTitle: "Scheduler",
        config,
        features,
        req,
        announcementWeb,
        jobs: jobsView,
        runs,
        forumScheduled,
        futurePosts,
        ...adminViewData(req, features),
      })
    );
  });

  // ── Editor (create/edit) ────────────────────────────────────────────────────
  async function renderEditor(req, res, { type, job, notices }) {
    const pickers = await pickerData();
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/scheduler/scheduler-editor", {
        pageTitle: type === "create" ? "Create Job" : "Edit Job",
        config,
        features,
        req,
        type,
        job: job || null,
        pickers,
        ...(notices ? { notices } : {}),
        ...adminViewData(req, features),
      })
    );
  }

  app.get("/dashboard/scheduler/create", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, true, req, res, features)) return;
    if (!await hasPermission(NODE, req, res, features)) return;
    return renderEditor(req, res, { type: "create" });
  });

  app.get("/dashboard/scheduler/edit", async function (req, res) {
    if (!await isFeatureWebRouteEnabled(app, true, req, res, features)) return;
    if (!await hasPermission(NODE, req, res, features)) return;
    const job = await getJob(Number(req.query.id));
    if (!job) return res.redirect("/dashboard/scheduler");
    return renderEditor(req, res, { type: "edit", job });
  });

  // ── Save (create/edit) ──────────────────────────────────────────────────────
  app.post("/dashboard/scheduler/save", async function (req, res) {
    if (!await hasPermission(NODE, req, res, features)) return;
    let payload;
    try { payload = JSON.parse(req.body?.payload || "{}"); }
    catch { return res.redirect("/dashboard/scheduler/create"); }

    const actor = req.session?.user?.userId ?? null;
    try {
      if (payload.id) {
        await updateJob(payload.id, payload, actor);
        await generateLog(actor, "SUCCESS", "SCHEDULER", `Edited job ${payload.id}: ${JSON.stringify(payload).slice(0, 500)}`).catch(() => {});
      } else {
        const id = await createJob(payload, actor);
        await generateLog(actor, "SUCCESS", "SCHEDULER", `Created job ${id}: ${JSON.stringify(payload).slice(0, 500)}`).catch(() => {});
      }
      res.setCookie?.("alertType", "success", { path: "/" });
      res.setCookie?.("alertContent", "Job saved.", { path: "/" });
      return res.redirect("/dashboard/scheduler");
    } catch (error) {
      const messages = error?.errors || [String(error?.message || error)];
      return renderEditor(req, res, {
        type: payload.id ? "edit" : "create",
        job: payload.id ? await getJob(payload.id) : { ...payload, actions: payload.actions },
        notices: messages.map((m) => ({ type: "danger", message: m })),
      });
    }
  });

  app.post("/dashboard/scheduler/delete", async function (req, res) {
    if (!await hasPermission(NODE, req, res, features)) return;
    const id = Number(req.body?.id);
    if (Number.isInteger(id)) {
      try { await deleteJob(id); await generateLog(req.session?.user?.userId ?? null, "WARNING", "SCHEDULER", `Deleted job ${id}`).catch(() => {}); }
      catch (e) { console.error("[dashboard/scheduler] delete failed:", e?.message || e); }
    }
    return res.redirect("/dashboard/scheduler");
  });

  app.post("/dashboard/scheduler/toggle", async function (req, res) {
    if (!await hasPermission(NODE, req, res, features)) return;
    const id = Number(req.body?.id);
    const enabled = String(req.body?.enabled) === "1";
    if (Number.isInteger(id)) {
      try { await setJobEnabled(id, enabled); await generateLog(req.session?.user?.userId ?? null, "SUCCESS", "SCHEDULER", `${enabled ? "Enabled" : "Disabled"} job ${id}`).catch(() => {}); }
      catch (e) { console.error("[dashboard/scheduler] toggle failed:", e?.message || e); }
    }
    return res.redirect("/dashboard/scheduler");
  });

  app.post("/dashboard/scheduler/duplicate", async function (req, res) {
    if (!await hasPermission(NODE, req, res, features)) return;
    const id = Number(req.body?.id);
    if (Number.isInteger(id)) {
      try {
        const newId = await duplicateJob(id, req.session?.user?.userId ?? null);
        return res.redirect(`/dashboard/scheduler/edit?id=${newId}`);
      } catch (e) { console.error("[dashboard/scheduler] duplicate failed:", e?.message || e); }
    }
    return res.redirect("/dashboard/scheduler");
  });

  // Live preview for the editor: next occurrences + per-action previews.
  app.post("/dashboard/scheduler/preview", async function (req, res) {
    if (!await hasPermission(NODE, req, res, features)) return;
    const job = req.body || {};
    const errors = validateJob(job);
    const occurrences = previewOccurrences(job, 5).map((d) => d.toISOString());
    const actions = previewActions(job);
    return res.send({ errors, occurrences, actions });
  });

  // Poll executor task status for queued command actions in the history tab.
  app.get("/dashboard/scheduler/task-status", async function (req, res) {
    if (!await hasPermission(NODE, req, res, features)) return;
    const ids = String(req.query.ids || "").split(",").map(Number).filter(Number.isInteger);
    if (!ids.length) return res.send({ tasks: [] });
    const tasks = await prisma.executorTasks.findMany({
      where: { executorTaskId: { in: ids } },
      select: { executorTaskId: true, status: true },
    }).catch(() => []);
    return res.send({ tasks });
  });

  app.post("/dashboard/scheduler/runnow", async function (req, res) {
    if (!await hasPermission(NODE, req, res, features)) return;
    const id = Number(req.body?.id);
    const actor = req.session?.user?.userId ?? null;
    if (Number.isInteger(id)) {
      try {
        const result = await runJobNow(id, actor, { client, config });
        await generateLog(actor, "WARNING", "SCHEDULER", `Ran job ${id} now (${result.status})`).catch(() => {});
        res.setCookie?.("alertType", result.status === "failed" ? "danger" : "success", { path: "/" });
        res.setCookie?.("alertContent", `Job run ${result.status}.`, { path: "/" });
      } catch (e) {
        console.error("[dashboard/scheduler] run now failed:", e?.message || e);
        res.setCookie?.("alertType", "danger", { path: "/" });
        res.setCookie?.("alertContent", `Run failed: ${e?.message || e}`, { path: "/" });
      }
    }
    return res.redirect("/dashboard/scheduler");
  });
}
