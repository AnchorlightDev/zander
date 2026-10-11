/**
 * routes/dashboard/resources.js
 *
 * Dashboard for community resources.
 *
 *   GET  /dashboard/resources?tab=review|published|rejected|categories
 *   POST /dashboard/resources/:id/vote          reviewers  (approve / reject)
 *   POST /dashboard/resources/:id/decide        managers: decide now (overrides the vote)
 *   POST /dashboard/resources                   managers: add a resource directly
 *   POST /dashboard/resources/:id/edit          managers
 *   POST /dashboard/resources/:id/delete        managers
 *   POST /dashboard/resources/categories        managers: add a category
 *   POST /dashboard/resources/categories/:id    managers: save a category
 *   POST /dashboard/resources/categories/:id/delete
 *
 * Reviewers hold zander.web.resources.review; managers hold
 * zander.web.resources. The vote rules are in lib/resources.mjs.
 */

import { getGlobalImage, hasPermission as requirePermission, setBannerCookie } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import {
  createCategory,
  createResource,
  deleteCategory,
  deleteResource,
  getCategoryById,
  getResourceById,
  getReviewerIds,
  isCategorySlugTaken,
  listCategories,
  listResources,
  updateCategory,
  updateResource,
} from "../../controllers/resourceController.js";
import { hasPermission } from "../../lib/discord/permissions.mjs";
import {
  MANAGE_PERMISSION,
  RESOURCE_LIMITS,
  REVIEW_PERMISSION,
  isOverdue,
  parseCategory,
  parseResource,
  tallyVotes,
} from "../../lib/resources.mjs";
import { castVote, decideManually, getVoterNames, refreshReviewMessage } from "../../services/resourceReviewService.js";

const TABS = ["review", "published", "rejected", "categories"];

export default function dashboardResourcesRoute(app, config, db, features, lang) {
  const roles = (req) => {
    const permissions = req.session?.user?.permissions;
    return { canReview: hasPermission(permissions, REVIEW_PERMISSION), canManage: hasPermission(permissions, MANAGE_PERMISSION) };
  };

  /** Reviewers and managers may open the page; anyone else gets the no-permission page. */
  async function requireAccess(req, res) {
    const { canReview, canManage } = roles(req);
    if (canReview || canManage) return true;
    await requirePermission(REVIEW_PERMISSION, req, res, features);
    return false;
  }

  const actor = (req) => req.session?.user?.username || "unknown";
  const back = (res, tab) => res.redirect(`/dashboard/resources?tab=${tab}`);

  app.get("/dashboard/resources", async function (req, res) {
    if (!(await requireAccess(req, res))) return;

    const { canReview, canManage } = roles(req);
    const tab = TABS.includes(req.query?.tab) ? req.query.tab : canReview ? "review" : "published";
    const userId = Number(req.session.user.userId);

    let categories = [];
    let resources = [];
    let reviewerCount = null;
    let error = null;
    try {
      categories = await listCategories();
      if (tab !== "categories") {
        const status = { review: "pending", published: "approved", rejected: "rejected" }[tab];
        resources = await listResources(status);
      }
      if (tab === "review") {
        const reviewers = await getReviewerIds();
        reviewerCount = reviewers.size;
        resources = await Promise.all(resources.map(async (r) => ({
          ...r,
          tally: tallyVotes(r.votes, reviewers),
          voters: await getVoterNames(r),
          myVote: r.votes.find((v) => v.userId === userId)?.vote || null,
          overdue: isOverdue(r),
        })));
      }
    } catch (err) {
      console.error("[dashboard/resources] failed to load:", err);
      error = "Could not load resources. Check the database and LuckPerms connections.";
    }

    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/resources/index", {
        pageTitle: "Dashboard - Resources",
        config,
        req,
        features,
        tab,
        canReview,
        canManage,
        categories,
        resources,
        reviewerCount,
        error,
        limits: RESOURCE_LIMITS,
        reviewChannelSet: Boolean(config.resources?.reviewChannelId),
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
      })
    );
  });

  // ── Voting and decisions ──────────────────────────────────────────────────

  app.post("/dashboard/resources/:id/vote", async function (req, res) {
    if (!(await requirePermission(REVIEW_PERMISSION, req, res, features))) return;
    try {
      const result = await castVote(req.params.id, req.session.user.userId, req.body?.vote);
      if (!result.ok) setBannerCookie("danger", result.error, res);
      else if (result.resource.status !== "pending") setBannerCookie("success", `Vote recorded. That settled it: "${result.resource.title}" was ${result.resource.status}.`, res);
      else setBannerCookie("success", "Vote recorded.", res);
    } catch (err) {
      console.error("[dashboard/resources] vote failed:", err);
      setBannerCookie("danger", "Your vote could not be recorded. Please try again.", res);
    }
    return back(res, "review");
  });

  app.post("/dashboard/resources/:id/decide", async function (req, res) {
    if (!(await requirePermission(MANAGE_PERMISSION, req, res, features))) return;
    try {
      const result = await decideManually(req.params.id, req.body?.status, req.session.user.userId);
      if (!result.ok) setBannerCookie("danger", result.error, res);
      else {
        console.log(`[dashboard/resources] ${actor(req)} ${result.resource.status} #${result.resource.resourceId} by hand`);
        setBannerCookie("success", `"${result.resource.title}" ${result.resource.status}.`, res);
      }
    } catch (err) {
      console.error("[dashboard/resources] decision failed:", err);
      setBannerCookie("danger", "The decision could not be saved. Please try again.", res);
    }
    return back(res, "review");
  });

  // ── Managing published resources ──────────────────────────────────────────

  app.post("/dashboard/resources", async function (req, res) {
    if (!(await requirePermission(MANAGE_PERMISSION, req, res, features))) return;
    const categories = await listCategories();
    const parsed = parseResource(req.body, categories.map((c) => c.categoryId));
    if (!parsed.ok) {
      setBannerCookie("danger", `Not added. ${parsed.errors.join(" ")}`, res);
      return back(res, "published");
    }
    await createResource({
      ...parsed.value,
      status: "approved",
      source: "staff",
      submittedByUserId: req.session.user.userId,
      submittedByName: req.session.user.username,
      decisionMethod: "staff",
      decidedByUserId: req.session.user.userId,
      decidedAt: new Date(),
    });
    console.log(`[dashboard/resources] ${actor(req)} added "${parsed.value.title}"`);
    setBannerCookie("success", `Added "${parsed.value.title}".`, res);
    return back(res, "published");
  });

  // Managers can edit anything; reviewers can tidy up a suggestion (typos, a
  // better title, the right category) while it is still being voted on.
  app.post("/dashboard/resources/:id/edit", async function (req, res) {
    if (!(await requireAccess(req, res))) return;
    const existing = await getResourceById(req.params.id);
    if (!existing) {
      setBannerCookie("danger", "That resource no longer exists.", res);
      return back(res, "published");
    }
    const tab = existing.status === "approved" ? "published" : existing.status === "pending" ? "review" : "rejected";
    if (existing.status !== "pending" && !roles(req).canManage) {
      setBannerCookie("danger", "Only resource managers can edit a resource once it has been decided.", res);
      return back(res, tab);
    }

    const categories = await listCategories();
    const parsed = parseResource(req.body, categories.map((c) => c.categoryId));
    if (!parsed.ok) setBannerCookie("danger", `Not saved. ${parsed.errors.join(" ")}`, res);
    else {
      await updateResource(existing.resourceId, parsed.value);
      if (existing.status === "pending") await refreshReviewMessage(existing.resourceId);
      console.log(`[dashboard/resources] ${actor(req)} edited #${existing.resourceId} "${parsed.value.title}"`);
      setBannerCookie("success", `Saved "${parsed.value.title}".`, res);
    }
    return back(res, tab);
  });

  app.post("/dashboard/resources/:id/delete", async function (req, res) {
    if (!(await requirePermission(MANAGE_PERMISSION, req, res, features))) return;
    const existing = await getResourceById(req.params.id);
    if (existing) {
      await deleteResource(existing.resourceId);
      console.log(`[dashboard/resources] ${actor(req)} deleted #${existing.resourceId} "${existing.title}"`);
      setBannerCookie("success", `Deleted "${existing.title}".`, res);
    }
    return back(res, existing?.status === "pending" ? "review" : existing?.status === "rejected" ? "rejected" : "published");
  });

  // ── Categories ────────────────────────────────────────────────────────────

  async function saveCategory(req, res, categoryId = null) {
    const parsed = parseCategory(req.body);
    if (parsed.ok && (await isCategorySlugTaken(parsed.value.slug, categoryId))) {
      setBannerCookie("danger", `Another category already uses the slug "${parsed.value.slug}".`, res);
      return back(res, "categories");
    }
    if (!parsed.ok) {
      setBannerCookie("danger", `Not saved. ${parsed.errors.join(" ")}`, res);
      return back(res, "categories");
    }
    if (categoryId) await updateCategory(categoryId, parsed.value);
    else await createCategory(parsed.value);
    setBannerCookie("success", `Category "${parsed.value.name}" saved.`, res);
    return back(res, "categories");
  }

  app.post("/dashboard/resources/categories", async function (req, res) {
    if (!(await requirePermission(MANAGE_PERMISSION, req, res, features))) return;
    return saveCategory(req, res);
  });

  app.post("/dashboard/resources/categories/:id", async function (req, res) {
    if (!(await requirePermission(MANAGE_PERMISSION, req, res, features))) return;
    const existing = await getCategoryById(req.params.id);
    if (!existing) {
      setBannerCookie("danger", "That category no longer exists.", res);
      return back(res, "categories");
    }
    return saveCategory(req, res, existing.categoryId);
  });

  app.post("/dashboard/resources/categories/:id/delete", async function (req, res) {
    if (!(await requirePermission(MANAGE_PERMISSION, req, res, features))) return;
    const result = await deleteCategory(req.params.id);
    if (!result.ok) setBannerCookie("danger", `That category still has ${result.inUse} resource(s). Move or delete them first.`, res);
    else setBannerCookie("success", "Category deleted.", res);
    return back(res, "categories");
  });
}
