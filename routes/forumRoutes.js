import {
  getCategoriesForUser,
  getCategoryBySlug,
  getDiscussionWithCategory,
  getDiscussionPosts,
  createDiscussion,
  updateDiscussion,
  deleteDiscussion,
  createReply,
  updatePost,
  deletePost,
  getPostById,
  getRecentDiscussions,
  getCategoryDiscussions,
  setDiscussionFlags,
  permissionMatch,
  getPostRevisions,
  moveDiscussion,
  getAllCategoriesForAdmin,
} from "../controllers/forumController.js";
import {
  validatePollInput,
  createPoll,
  getPollByDiscussionId,
  castVote,
  changeVote,
} from "../controllers/forumPollController.js";
import {
  getGlobalImage,
  isFeatureWebRouteEnabled,
  isLoggedIn,
  setBannerCookie,
} from "../api/common.js";
import { UserGetter } from "../controllers/userController.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";
import { hasActiveWebBan } from "../controllers/discordPunishmentController.js";

const PERMISSIONS = {
  MODERATE: "zander.forums.moderate",
  DELETE_POST: "zander.forums.post.delete",
  VIEW_ARCHIVED: "zander.forums.viewArchived",
  STICKY: "zander.forums.discussion.sticky",
  LOCK: "zander.forums.discussion.lock",
  ARCHIVE: "zander.forums.discussion.archive",
};

function getUserPermissions(req) {
  const permissions = Array.isArray(req.session?.user?.permissions)
    ? [...req.session.user.permissions]
    : [];

  // Add @authenticated pseudo-permission for logged-in users
  // This allows categories to require login by setting viewPermission to "@authenticated"
  if (isLoggedIn(req)) {
    permissions.push("@authenticated");
  }

  return permissions;
}

function getCurrentUserId(req) {
  return req.session?.user?.userId || null;
}

function isContentEmpty(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return true;
  }

  // Limit input length before applying regex to prevent ReDoS
  const capped = String(rawValue).slice(0, 50_000);
  const stripped = capped
    .replace(/<[^>]{0,2000}>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .trim();

  return stripped.length === 0;
}

function userCanViewCategory(category, req) {
  // Special permission: @authenticated means user must be logged in
  if (category.viewPermission === "@authenticated") {
    return isLoggedIn(req);
  }
  const permissions = getUserPermissions(req);
  return permissionMatch(permissions, category.viewPermission);
}

function userCanPostInCategory(category, req) {
  if (!isLoggedIn(req)) {
    return false;
  }

  if (!category.postPermission) {
    return true;
  }

  // Special permission: @authenticated means any logged-in user can post
  if (category.postPermission === "@authenticated") {
    return true;
  }

  const permissions = getUserPermissions(req);
  return permissionMatch(permissions, category.postPermission);
}

function userCanModerate(req) {
  const permissions = getUserPermissions(req);
  return permissionMatch(permissions, PERMISSIONS.MODERATE);
}

function userCanDeleteAnyPost(req) {
  const permissions = getUserPermissions(req);
  return (
    permissionMatch(permissions, PERMISSIONS.DELETE_POST) ||
    permissionMatch(permissions, PERMISSIONS.MODERATE)
  );
}

function includeArchivedDiscussions(req) {
  const permissions = getUserPermissions(req);
  return (
    permissionMatch(permissions, PERMISSIONS.MODERATE) ||
    permissionMatch(permissions, PERMISSIONS.VIEW_ARCHIVED)
  );
}

function userCanSticky(req) {
  const permissions = getUserPermissions(req);
  return (
    permissionMatch(permissions, PERMISSIONS.STICKY) ||
    permissionMatch(permissions, PERMISSIONS.MODERATE)
  );
}

function userCanLock(req) {
  const permissions = getUserPermissions(req);
  return (
    permissionMatch(permissions, PERMISSIONS.LOCK) ||
    permissionMatch(permissions, PERMISSIONS.MODERATE)
  );
}

function userCanArchive(req) {
  const permissions = getUserPermissions(req);
  return (
    permissionMatch(permissions, PERMISSIONS.ARCHIVE) ||
    permissionMatch(permissions, PERMISSIONS.MODERATE)
  );
}

function paginate(total, page, perPage) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  return {
    total,
    perPage,
    currentPage,
    totalPages,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}

function getSiteBaseUrl(req) {
  const configuredAddress =
    typeof process.env.siteAddress === "string"
      ? process.env.siteAddress.trim()
      : "";

  if (configuredAddress) {
    return configuredAddress.replace(/\/$/, "");
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const protocol =
    req.headers["x-forwarded-proto"] || req.protocol || "https";

  if (protocol && host) {
    return `${protocol}://${host}`;
  }

  return "";
}

function buildPostPermalink(req, discussion, postId) {
  if (!discussion || !postId) {
    return "";
  }

  const baseUrl = getSiteBaseUrl(req);
  if (!baseUrl) {
    return "";
  }

  const slug = discussion.slug ? `/${discussion.slug}` : "";
  return `${baseUrl}/forums/discussion/${discussion.discussionId}${slug}#post-${postId}`;
}

const FORUM_LOG_COLORS = {
  create: 0x22c55e,   // green
  reply: 0x3b82f6,    // blue
  edit: 0xf59e0b,     // amber
  delete: 0xef4444,   // red
  lock: 0xf97316,     // orange
  unlock: 0x22c55e,   // green
  sticky: 0xa855f7,   // purple
  unsticky: 0x6b7280, // gray
  archive: 0x64748b,  // slate
  unarchive: 0x22c55e,// green
  report: 0xdc2626,   // red
};

function stripHtmlAndTruncate(html, maxLength = 200) {
  if (!html) return "";
  // Limit input length before applying regex to prevent ReDoS
  const capped = String(html).slice(0, 50_000);
  const text = capped
    .replace(/<[^>]{0,2000}>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "…";
}

function sendForumLog(config, { action, title, description, url, avatarUrl, fields }) {
  const webhookUrl = config.discord?.webhooks?.forumLog;
  if (!webhookUrl) return;

  try {
    const hook = new Webhook(webhookUrl);
    const embed = new MessageBuilder()
      .setTitle(title)
      .setColor(FORUM_LOG_COLORS[action] || 0x6b7280)
      .setTimestamp();

    if (description) embed.setDescription(description);
    if (url) embed.setURL(url);
    if (avatarUrl) embed.setThumbnail(avatarUrl);
    if (fields) {
      fields.forEach(([name, value, inline]) => {
        if (value) embed.addField(name, value, inline ?? true);
      });
    }

    sendWebhookMessage(hook, embed, { context: `forums#${action}` });
  } catch (err) {
    console.error("Failed to send forum log webhook", err);
  }
}

async function renderForumsView(app, res, req, viewPath, data, config, features) {
  const [globalImage, announcementWeb] = await Promise.all([
    getGlobalImage(),
    getWebAnnouncement(),
  ]);

  res
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(
    await app.view(viewPath, {
      ...data,
      config,
      features,
      req,
      globalImage,
      announcementWeb,
    })
  );
}

export default function forumRoutes(
  app,
  client,
  fetch,
  moment,
  config,
  db,
  features,
  lang
) {
  const ensureFeature = async (req, res) => {
    if (!features.forums) {
      if (!await isFeatureWebRouteEnabled(app, features.forums, req, res, features)) return;
      return false;
    }

    return true;
  };

  const userGetter = new UserGetter();

  app.get("/fourms", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    return res.redirect(301, "/forums");
  });

  app.get("/forums", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    try {
      const permissions = getUserPermissions(req);
      const includeArchived = includeArchivedDiscussions(req);
      const categoryData = await getCategoriesForUser(permissions);
      const categoryIds = (categoryData.flat || []).map(
        (category) => category.categoryId
      );

      const page = Number.parseInt(req.query.page, 10) || 1;
      const perPage = 20;

      const { discussions, total } = await getRecentDiscussions({
        categoryIds,
        page,
        perPage,
        includeArchived,
      });

      await renderForumsView(
        app,
        res,
        req,
        "modules/forums/index",
        {
          pageTitle: `Recent Discussions`,
          categories: categoryData.tree,
          discussions,
          activeCategory: null,
          pagination: paginate(total, page, perPage),
          moment,
          canModerate: userCanModerate(req),
        },
        config,
        features
      );
    } catch (error) {
      console.error("[FORUMS] GET /forums error:", error);
      if (!res.sent) throw error;
    }
    return;
  });

  app.get("/forums/category/:slug", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    try {
      const slug = req.params.slug;
      const category = await getCategoryBySlug(slug);

      const permissions = getUserPermissions(req);
      const categoryTree = await getCategoriesForUser(permissions);

      if (!category || !userCanViewCategory(category, req)) {
        await renderForumsView(
          app,
          res,
          req,
          "session/notFound",
          {
            pageTitle: `404 Not Found`,
          },
          config,
          features
        );
        return;
      }

      const includeArchived = includeArchivedDiscussions(req);
      const page = Number.parseInt(req.query.page, 10) || 1;
      const perPage = 20;

      const { discussions, total } = await getCategoryDiscussions({
        categoryId: category.categoryId,
        page,
        perPage,
        includeArchived,
      });

      await renderForumsView(
        app,
        res,
        req,
        "modules/forums/category",
        {
          pageTitle: `${category.name}`,
          categories: categoryTree.tree,
          activeCategory: category,
          category,
          discussions,
          pagination: paginate(total, page, perPage),
          moment,
          canModerate: userCanModerate(req),
          canStartDiscussion:
            userCanPostInCategory(category, req) || userCanModerate(req),
        },
        config,
        features
      );
    } catch (error) {
      console.error("[FORUMS] GET /forums/category/:slug error:", error);
      if (!res.sent) throw error;
    }
    return;
  });

  app.get("/forums/category/:slug/new", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    try {
      const slug = req.params.slug;
      const category = await getCategoryBySlug(slug);

      if (!category || !userCanViewCategory(category, req)) {
        await renderForumsView(
          app,
          res,
          req,
          "session/notFound",
          {
            pageTitle: `404 Not Found`,
          },
          config,
          features
        );
        return;
      }

      if (!userCanPostInCategory(category, req) && !userCanModerate(req)) {
        if (!isLoggedIn(req)) {
          setBannerCookie(
            "warning",
            "You need to be signed in to start a discussion.",
            res
          );
          return res.redirect(`/login`);
        }

        await renderForumsView(
          app,
          res,
          req,
          "session/noPermission",
          {
            pageTitle: `Access Restricted`,
          },
          config,
          features
        );
        return;
      }

      const permissions = getUserPermissions(req);
      const categoryTree = await getCategoriesForUser(permissions);

      await renderForumsView(
        app,
        res,
        req,
        "modules/forums/newDiscussion",
        {
          pageTitle: `Start a Discussion`,
          categories: categoryTree.tree,
          activeCategory: category,
          category,
        },
        config,
        features
      );
    } catch (error) {
      console.error("[FORUMS] GET /forums/category/:slug/new error:", error);
      if (!res.sent) throw error;
    }
    return;
  });

  app.post("/forums/category/:slug", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    if (await hasActiveWebBan(getCurrentUserId(req))) {
      setBannerCookie("danger", "You are currently banned and cannot create discussions.", res);
      return res.redirect("/forums");
    }

    const slug = req.params.slug;
    const category = await getCategoryBySlug(slug);

    if (!category || !userCanViewCategory(category, req)) {
      await renderForumsView(
        app,
        res,
        req,
        "session/notFound",
        {
          pageTitle: `404 Not Found`,
        },
        config,
        features
      );
      return;
    }

    if (!userCanPostInCategory(category, req) && !userCanModerate(req)) {
      setBannerCookie(
        "danger",
        "You do not have permission to start a discussion in this category.",
        res
      );
      return res.redirect(`/forums/category/${category.slug}`);
    }

    const title = (req.body.title || "").trim();
    const content = req.body.content || "";

    const userId = getCurrentUserId(req);

    if (!userId) {
      setBannerCookie(
        "warning",
        "You need to be signed in to start a discussion.",
        res
      );
      return res.redirect(`/login`);
    }

    if (!title || isContentEmpty(content)) {
      setBannerCookie(
        "danger",
        "Both a title and content are required to create a discussion.",
        res
      );
      return res.redirect(`/forums/category/${category.slug}/new`);
    }

    // Validate poll fields before creating the discussion
    const pollEnabled = req.body.pollEnabled === "1";
    let parsedPollOptions = [];
    let parsedOptionImages = [];
    if (pollEnabled) {
      let rawOptions = req.body.pollOptions;
      if (!Array.isArray(rawOptions)) rawOptions = rawOptions ? [rawOptions] : [];
      parsedPollOptions = rawOptions.map((o) => (o || "").trim()).filter((o) => o);

      let rawImages = req.body.pollOptionImages;
      if (!Array.isArray(rawImages)) rawImages = rawImages ? [rawImages] : [];
      parsedOptionImages = rawOptions.map((_, i) => {
        const u = (rawImages[i] || "").trim();
        return (u.startsWith("http://") || u.startsWith("https://")) ? u : null;
      });

      const pollErrors = validatePollInput({
        question: req.body.pollQuestion,
        options: parsedPollOptions,
        expiresAt: req.body.pollExpiresAt || null,
      });

      if (pollErrors.length) {
        setBannerCookie("danger", pollErrors[0], res);
        return res.redirect(`/forums/category/${category.slug}/new`);
      }
    }

    try {
      const discussion = await createDiscussion({
        categoryId: category.categoryId,
        userId,
        title,
        content,
      });

      if (pollEnabled) {
        try {
          await createPoll(discussion.discussionId, userId, {
            question: (req.body.pollQuestion || "").trim(),
            options: parsedPollOptions,
            imageUrls: parsedOptionImages,
            allowMultiple: req.body.pollAllowMultiple === "1",
            allowVoteChange: req.body.pollAllowVoteChange === "1",
            showVoters: req.body.pollShowVoters === "1",
            expiresAt: req.body.pollExpiresAt || null,
          });
        } catch (pollErr) {
          console.error("[FORUMS] Failed to create poll, discussion created without one", pollErr);
        }
      }

      const baseUrl = getSiteBaseUrl(req);
      const username = req.session?.user?.username || "Unknown";
      const uuid = req.session?.user?.uuid;
      const contentSnippet = stripHtmlAndTruncate(content);
      sendForumLog(config, {
        action: "create",
        title: "New Discussion Created",
        description: `**${title}**`,
        url: baseUrl ? `${baseUrl}/forums/discussion/${discussion.discussionId}/${discussion.slug}` : undefined,
        avatarUrl: uuid ? `https://crafthead.net/helm/${uuid}` : undefined,
        fields: [
          ["Author", username],
          ["Category", category.name],
          ["Content", contentSnippet || "—", false],
        ],
      });

      setBannerCookie(
        "success",
        "Discussion created successfully.",
        res
      );

      return res.redirect(
        `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
      );
    } catch (error) {
      console.error("[FORUMS] Failed to create discussion", error);
      setBannerCookie(
        "danger",
        "We were unable to create your discussion. Please try again.",
        res
      );
      return res.redirect(`/forums/category/${category.slug}`);
    }
  });

  const discussionViewHandler = async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    try {
      const discussionId = Number.parseInt(req.params.discussionId, 10);
      const result = await getDiscussionWithCategory(discussionId);

      if (!result) {
        await renderForumsView(
          app,
          res,
          req,
          "session/notFound",
          {
            pageTitle: `404 Not Found`,
          },
          config,
          features
        );
        return;
      }

      const { discussion, category } = result;

      if (!userCanViewCategory(category, req)) {
        await renderForumsView(
          app,
          res,
          req,
          "session/notFound",
          {
            pageTitle: `404 Not Found`,
          },
          config,
          features
        );
        return;
      }

      if (req.params.slug && req.params.slug !== discussion.slug) {
        res.redirect(
          `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
        );
        return;
      }

      const permissions = getUserPermissions(req);
      const canModerate = userCanModerate(req);

      const [categoryTree, posts, allCategories] = await Promise.all([
        getCategoriesForUser(permissions),
        getDiscussionPosts(discussionId),
        canModerate ? getAllCategoriesForAdmin() : Promise.resolve({ flat: [] }),
      ]);

      // postPermission gates starting new discussions only — any signed-in
      // user who can view the category may reply to an existing one.
      const canReply =
        !discussion.isLocked &&
        !discussion.isArchived &&
        (isLoggedIn(req) || canModerate);

      const viewerUserId = req.session?.user?.userId || null;
      const poll = await getPollByDiscussionId(discussionId, viewerUserId).catch((err) => {
        console.error("[FORUMS] Failed to load poll", err);
        return null;
      });

      await renderForumsView(
        app,
        res,
        req,
        "modules/forums/discussion",
        {
          pageTitle: `${discussion.title}`,
          categories: categoryTree.tree,
          activeCategory: category,
          category,
          discussion,
          posts,
          poll,
          moment,
          canReply,
          canModerate,
          canSticky: userCanSticky(req),
          canLock: userCanLock(req),
          canArchive: userCanArchive(req),
          currentUserId: viewerUserId,
          canDeleteAnyPost: userCanDeleteAnyPost(req),
          moveCategories: allCategories.flat,
        },
        config,
        features
      );
    } catch (error) {
      console.error("[FORUMS] GET /forums/discussion error:", error);
      if (!res.sent) throw error;
    }
    return;
  };

  app.get("/forums/discussion/:discussionId", discussionViewHandler);
  app.get("/forums/discussion/:discussionId/:slug", discussionViewHandler);

  const discussionReplyHandler = async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    if (await hasActiveWebBan(getCurrentUserId(req))) {
      setBannerCookie("danger", "You are currently banned and cannot post replies.", res);
      return res.redirect("/forums");
    }

    const discussionId = Number.parseInt(req.params.discussionId, 10);
    const result = await getDiscussionWithCategory(discussionId);

    if (!result) {
      setBannerCookie("danger", "Discussion not found.", res);
      return res.redirect("/forums");
    }

    const { discussion, category } = result;

    if (!userCanViewCategory(category, req)) {
      setBannerCookie("danger", "You cannot reply to this discussion.", res);
      return res.redirect("/forums");
    }

    if (discussion.isLocked && !userCanModerate(req)) {
      setBannerCookie("warning", "This discussion is locked.", res);
      return res.redirect(
        `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
      );
    }

    if (discussion.isArchived && !userCanModerate(req)) {
      setBannerCookie(
        "warning",
        "This discussion has been archived.",
        res
      );
      return res.redirect(
        `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
      );
    }

    const userId = getCurrentUserId(req);

    if (!userId) {
      setBannerCookie(
        "warning",
        "You need to be signed in to reply.",
        res
      );
      return res.redirect(`/login`);
    }

    // postPermission gates starting new discussions only — signed-in users
    // (checked above) who can view this category may reply.

    const content = req.body.content || "";
    if (isContentEmpty(content)) {
      setBannerCookie(
        "danger",
        "Reply content cannot be empty.",
        res
      );
      return res.redirect(
        `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
      );
    }

    let replyToPostId = Number.parseInt(req.body.replyToPostId, 10) || null;
    if (replyToPostId) {
      const replyTarget = await getPostById(replyToPostId);
      if (!replyTarget || replyTarget.discussionId !== discussionId) {
        setBannerCookie("danger", "The post you are replying to could not be found.", res);
        return res.redirect(
          `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
        );
      }
    }

    let createdPostId = null;
    try {
      createdPostId = await createReply({
        discussionId,
        userId,
        content,
        replyToPostId,
      });

      const baseUrl = getSiteBaseUrl(req);
      const username = req.session?.user?.username || "Unknown";
      const uuid = req.session?.user?.uuid;
      const contentSnippet = stripHtmlAndTruncate(content);
      sendForumLog(config, {
        action: "reply",
        title: "New Reply Posted",
        description: `Reply to **${discussion.title || `Discussion #${discussionId}`}**`,
        url: baseUrl ? `${baseUrl}/forums/discussion/${discussion.discussionId}/${discussion.slug}` : undefined,
        avatarUrl: uuid ? `https://crafthead.net/helm/${uuid}` : undefined,
        fields: [
          ["Author", username],
          ["Category", category?.name || "Unknown"],
          ["Content", contentSnippet || "—", false],
        ],
      });

      setBannerCookie("success", "Reply posted.", res);
    } catch (error) {
      console.error("[FORUMS] Failed to create reply", error);
      setBannerCookie(
        "danger",
        "We were unable to post your reply. Please try again.",
        res
      );
    }

    return res.redirect(
      `/forums/discussion/${discussion.discussionId}/${discussion.slug}${createdPostId ? `#post-${createdPostId}` : ""}`
    );
  };

  app.post("/forums/discussion/:discussionId/reply", discussionReplyHandler);
  app.post(
    "/forums/discussion/:discussionId/:slug/reply",
    discussionReplyHandler
  );

  app.get("/forums/discussion/:discussionId/edit", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    try {
      const discussionId = Number.parseInt(req.params.discussionId, 10);
      const result = await getDiscussionWithCategory(discussionId);

      if (!result) {
        await renderForumsView(
          app,
          res,
          req,
          "session/notFound",
          {
            pageTitle: `404 Not Found`,
          },
          config,
          features
        );
        return;
      }

      const { discussion, category } = result;

      if (!userCanViewCategory(category, req)) {
        await renderForumsView(
          app,
          res,
          req,
          "session/notFound",
          {
            pageTitle: `404 Not Found`,
          },
          config,
          features
        );
        return;
      }

      const canModerate = userCanModerate(req);
      const isAuthor = getCurrentUserId(req) === discussion.createdBy;

      if (!canModerate && !isAuthor) {
        await renderForumsView(
          app,
          res,
          req,
          "session/noPermission",
          {
            pageTitle: `Access Restricted`,
          },
          config,
          features
        );
        return;
      }

      const permissions = getUserPermissions(req);
      const [posts, categoryTree] = await Promise.all([
        getDiscussionPosts(discussionId),
        getCategoriesForUser(permissions),
      ]);
      const originalPost = posts.find((post) => post.isOriginal);

      await renderForumsView(
        app,
        res,
        req,
        "modules/forums/editDiscussion",
        {
          pageTitle: `Edit Discussion`,
          categories: categoryTree.tree,
          activeCategory: category,
          category,
          discussion,
          originalPost,
        },
        config,
        features
      );
    } catch (error) {
      console.error("[FORUMS] GET /forums/discussion/:id/edit error:", error);
      if (!res.sent) throw error;
    }
    return;
  });

  app.post("/forums/discussion/:discussionId/edit", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    if (await hasActiveWebBan(getCurrentUserId(req))) {
      setBannerCookie("danger", "You are currently banned and cannot edit discussions.", res);
      return res.redirect("/forums");
    }

    const discussionId = Number.parseInt(req.params.discussionId, 10);
    const result = await getDiscussionWithCategory(discussionId);

    if (!result) {
      setBannerCookie("danger", "Discussion not found.", res);
      return res.redirect("/forums");
    }

    const { discussion, category } = result;

    const canModerate = userCanModerate(req);
    const isAuthor = req.session?.user?.userId === discussion.createdBy;

    if (!canModerate && !isAuthor) {
      setBannerCookie(
        "danger",
        "You do not have permission to edit this discussion.",
        res
      );
      return res.redirect(
        `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
      );
    }

    const title = (req.body.title || "").trim();
    const content = req.body.content || "";

    if (!title || isContentEmpty(content)) {
      setBannerCookie(
        "danger",
        "A title and body are required.",
        res
      );
      return res.redirect(
        `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
      );
    }

    try {
      await updateDiscussion(discussionId, {
        title,
        content,
        editorUserId: getCurrentUserId(req),
      });

      const baseUrl = getSiteBaseUrl(req);
      const username = req.session?.user?.username || "Unknown";
      const uuid = req.session?.user?.uuid;
      const contentSnippet = stripHtmlAndTruncate(content);
      sendForumLog(config, {
        action: "edit",
        title: "Discussion Edited",
        description: `**${title}**`,
        url: baseUrl ? `${baseUrl}/forums/discussion/${discussion.discussionId}/${discussion.slug}` : undefined,
        avatarUrl: uuid ? `https://crafthead.net/helm/${uuid}` : undefined,
        fields: [
          ["Edited By", username],
          ["Category", category?.name || "Unknown"],
          ["Content", contentSnippet || "—", false],
        ],
      });

      setBannerCookie("success", "Discussion updated.", res);
    } catch (error) {
      console.error("[FORUMS] Failed to update discussion", error);
      setBannerCookie(
        "danger",
        "We were unable to update the discussion.",
        res
      );
    }

    return res.redirect(
      `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
    );
  });

  app.post("/forums/discussion/:discussionId/delete", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    if (await hasActiveWebBan(getCurrentUserId(req))) {
      setBannerCookie("danger", "You are currently banned and cannot delete discussions.", res);
      return res.redirect("/forums");
    }

    const discussionId = Number.parseInt(req.params.discussionId, 10);
    const result = await getDiscussionWithCategory(discussionId);

    if (!result) {
      setBannerCookie("danger", "Discussion not found.", res);
      return res.redirect("/forums");
    }

    const { discussion, category } = result;

    const canModerate = userCanModerate(req);
    const isAuthor = getCurrentUserId(req) === discussion.createdBy;

    if (!canModerate && !isAuthor) {
      setBannerCookie(
        "danger",
        "You do not have permission to delete this discussion.",
        res
      );
      return res.redirect(
        `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
      );
    }

    try {
      await deleteDiscussion(discussionId);

      const username = req.session?.user?.username || "Unknown";
      const uuid = req.session?.user?.uuid;
      sendForumLog(config, {
        action: "delete",
        title: "Discussion Deleted",
        description: `**${discussion.title || `Discussion #${discussionId}`}**`,
        avatarUrl: uuid ? `https://crafthead.net/helm/${uuid}` : undefined,
        fields: [
          ["Deleted By", username],
          ["Category", category?.name || "Unknown"],
        ],
      });

      setBannerCookie("success", "Discussion deleted.", res);
      return res.redirect(`/forums/category/${category.slug}`);
    } catch (error) {
      console.error("[FORUMS] Failed to delete discussion", error);
      setBannerCookie(
        "danger",
        "We were unable to delete the discussion.",
        res
      );
      return res.redirect(
        `/forums/discussion/${discussion.discussionId}/${discussion.slug}`
      );
    }
  });

  app.get("/forums/post/:postId/edit", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    try {
      const postId = Number.parseInt(req.params.postId, 10);
      const post = await getPostById(postId);

      if (!post) {
        await renderForumsView(
          app,
          res,
          req,
          "session/notFound",
          {
            pageTitle: `404 Not Found`,
          },
          config,
          features
        );
        return;
      }

      const result = await getDiscussionWithCategory(post.discussionId);

      if (!result || !userCanViewCategory(result.category, req)) {
        await renderForumsView(
          app,
          res,
          req,
          "session/notFound",
          {
            pageTitle: `404 Not Found`,
          },
          config,
          features
        );
        return;
      }

      if (post.isOriginal) {
        return res.redirect(
          `/forums/discussion/${post.discussionId}/edit`
        );
      }

      const canModerate = userCanModerate(req);
      const isAuthor = getCurrentUserId(req) === post.userId;

      if (!canModerate && !isAuthor) {
        await renderForumsView(
          app,
          res,
          req,
          "session/noPermission",
          {
            pageTitle: `Access Restricted`,
          },
          config,
          features
        );
        return;
      }

      const permissions = getUserPermissions(req);
      const categoryTree = await getCategoriesForUser(permissions);

      await renderForumsView(
        app,
        res,
        req,
        "modules/forums/editPost",
        {
          pageTitle: `Edit Reply`,
          categories: categoryTree.tree,
          activeCategory: result.category,
          category: result.category,
          discussion: result.discussion,
          post,
        },
        config,
        features
      );
    } catch (error) {
      console.error("[FORUMS] GET /forums/post/:postId/edit error:", error);
      if (!res.sent) throw error;
    }
    return;
  });

  app.post("/forums/post/:postId/edit", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    if (await hasActiveWebBan(getCurrentUserId(req))) {
      setBannerCookie("danger", "You are currently banned and cannot edit posts.", res);
      return res.redirect("/forums");
    }

    const postId = Number.parseInt(req.params.postId, 10);
    const post = await getPostById(postId);

    if (!post) {
      setBannerCookie("danger", "Post not found.", res);
      return res.redirect("/forums");
    }

    if (post.isOriginal) {
      return res.redirect(`/forums/discussion/${post.discussionId}/edit`);
    }

    const result = await getDiscussionWithCategory(post.discussionId);

    if (!result || !userCanViewCategory(result.category, req)) {
      setBannerCookie(
        "danger",
        "You do not have permission to edit this post.",
        res
      );
      return res.redirect("/forums");
    }

    const canModerate = userCanModerate(req);
    const isAuthor = getCurrentUserId(req) === post.userId;

    if (!canModerate && !isAuthor) {
      setBannerCookie(
        "danger",
        "You do not have permission to edit this post.",
        res
      );
      return res.redirect(
        `/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`
      );
    }

    const content = req.body.content || "";
    if (isContentEmpty(content)) {
      setBannerCookie("danger", "Post content cannot be empty.", res);
      return res.redirect(
        `/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`
      );
    }

    try {
      await updatePost(postId, {
        content,
        editorUserId: getCurrentUserId(req),
      });

      const baseUrl = getSiteBaseUrl(req);
      const username = req.session?.user?.username || "Unknown";
      const uuid = req.session?.user?.uuid;
      const contentSnippet = stripHtmlAndTruncate(content);
      sendForumLog(config, {
        action: "edit",
        title: "Reply Edited",
        description: `Reply in **${result.discussion.title || `Discussion #${result.discussion.discussionId}`}**`,
        url: baseUrl ? `${baseUrl}/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}#post-${postId}` : undefined,
        avatarUrl: uuid ? `https://crafthead.net/helm/${uuid}` : undefined,
        fields: [
          ["Edited By", username],
          ["Content", contentSnippet || "—", false],
        ],
      });

      setBannerCookie("success", "Post updated.", res);
    } catch (error) {
      console.error("[FORUMS] Failed to update post", error);
      setBannerCookie(
        "danger",
        "We were unable to update the post.",
        res
      );
    }

    return res.redirect(
      `/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`
    );
  });

  app.post("/forums/post/:postId/delete", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    if (await hasActiveWebBan(getCurrentUserId(req))) {
      setBannerCookie("danger", "You are currently banned and cannot delete posts.", res);
      return res.redirect("/forums");
    }

    const postId = Number.parseInt(req.params.postId, 10);
    const post = await getPostById(postId);

    if (!post) {
      setBannerCookie("danger", "Post not found.", res);
      return res.redirect("/forums");
    }

    const result = await getDiscussionWithCategory(post.discussionId);

    if (!result || !userCanViewCategory(result.category, req)) {
      setBannerCookie(
        "danger",
        "You do not have permission to delete this post.",
        res
      );
      return res.redirect("/forums");
    }

    if (post.isOriginal) {
      setBannerCookie(
        "danger",
        "The first post in a discussion cannot be deleted individually.",
        res
      );
      return res.redirect(
        `/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`
      );
    }

    const canModerate = userCanModerate(req);
    const isAuthor = getCurrentUserId(req) === post.userId;

    if (!canModerate && !isAuthor && !userCanDeleteAnyPost(req)) {
      setBannerCookie(
        "danger",
        "You do not have permission to delete this post.",
        res
      );
      return res.redirect(
        `/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`
      );
    }

    try {
      await deletePost(postId);

      const username = req.session?.user?.username || "Unknown";
      const uuid = req.session?.user?.uuid;
      sendForumLog(config, {
        action: "delete",
        title: "Reply Deleted",
        description: `Reply removed from **${result.discussion.title || `Discussion #${result.discussion.discussionId}`}**`,
        avatarUrl: uuid ? `https://crafthead.net/helm/${uuid}` : undefined,
        fields: [
          ["Deleted By", username],
        ],
      });

      setBannerCookie("success", "Post deleted.", res);
    } catch (error) {
      console.error("[FORUMS] Failed to delete post", error);
      setBannerCookie(
        "danger",
        "We were unable to delete the post.",
        res
      );
    }

    return res.redirect(
      `/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`
    );
  });

  app.post("/forums/post/:postId/report", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    if (!features.report) {
      res.status(404);
      return res.send({
        success: false,
        message: "Reporting is currently disabled.",
      });
    }

    if (!isLoggedIn(req)) {
      res.status(401);
      return res.send({
        success: false,
        message: "You must be logged in to report forum posts.",
      });
    }

    const postId = Number.parseInt(req.params.postId, 10);
    if (!Number.isFinite(postId) || postId <= 0) {
      res.status(400);
      return res.send({
        success: false,
        message: "Invalid post identifier.",
      });
    }

    const rawReason =
      typeof req.body?.reportReason === "string" ? req.body.reportReason : "";
    const reason = rawReason.trim();

    if (!reason) {
      res.status(400);
      return res.send({
        success: false,
        message: "Please provide a reason for your report.",
      });
    }

    const rawDetails =
      typeof req.body?.reportReasonEvidence === "string"
        ? req.body.reportReasonEvidence
        : "";
    const details = rawDetails.trim();

    try {
      const post = await getPostById(postId);
      if (!post) {
        res.status(404);
        return res.send({
          success: false,
          message: "Post not found.",
        });
      }

      const info = await getDiscussionWithCategory(post.discussionId);
      if (!info || !info.discussion || !info.category) {
        res.status(404);
        return res.send({
          success: false,
          message: "Discussion not found.",
        });
      }

      if (!userCanViewCategory(info.category, req)) {
        res.status(403);
        return res.send({
          success: false,
          message: "You do not have permission to report this post.",
        });
      }

      const author = post.userId ? await userGetter.byUserId(post.userId) : null;
      if (!author || !author.username) {
        res.status(404);
        return res.send({
          success: false,
          message: "Unable to resolve the post author.",
        });
      }

      const truncatedReason = reason.length > 100 ? reason.slice(0, 100) : reason;
      const permalink = buildPostPermalink(req, info.discussion, post.postId);
      const evidenceParts = [];

      if (permalink) {
        evidenceParts.push(`Forum link: ${permalink}`);
      }

      if (details) {
        evidenceParts.push(details);
      }

      const reporterUsername = req.session?.user?.username;
      if (!reporterUsername) {
        res.status(401);
        return res.send({
          success: false,
          message: "You must be logged in to report forum posts.",
        });
      }

      const reportBody = {
        reporterUser: reporterUsername,
        reportedUser: author.username,
        reportReason: truncatedReason,
        reportReasonEvidence: evidenceParts.join("\n\n") || null,
        reportPlatform: "FORUM",
      };

      const apiResponse = await fetch(
        `${process.env.siteAddress}/api/report/create`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-access-token": process.env.apiKey,
          },
          body: JSON.stringify(reportBody),
        }
      );

      const data = await apiResponse.json().catch(() => null);

      if (!apiResponse.ok || !data?.success) {
        const message =
          data?.message ||
          "Unable to submit your report right now. Please try again later.";

        res.status(apiResponse.status >= 400 ? apiResponse.status : 500);
        return res.send({
          success: false,
          message,
        });
      }

      const uuid = req.session?.user?.uuid;
      sendForumLog(config, {
        action: "report",
        title: "Post Reported",
        description: `A post by **${author?.username || "Unknown"}** was reported`,
        avatarUrl: uuid ? `https://crafthead.net/helm/${uuid}` : undefined,
        fields: [
          ["Reported By", reporterUsername],
          ["Reason", truncatedReason, false],
        ],
      });

      return res.send({
        success: true,
        message:
          data.message || "Thanks for letting us know. Your report has been received.",
      });
    } catch (error) {
      console.error("Failed to submit forum report:", error);
      res.status(500);
      return res.send({
        success: false,
        message: "An unexpected error occurred while submitting your report.",
      });
    }
  });

  app.post(
    "/forums/discussion/:discussionId/moderate",
    async function (req, res) {
      if (!(await ensureFeature(req, res))) {
        return;
      }

      const discussionId = Number.parseInt(req.params.discussionId, 10);
      const result = await getDiscussionWithCategory(discussionId);

      if (!result) {
        setBannerCookie("danger", "Discussion not found.", res);
        return res.redirect("/forums");
      }

      const action = (req.body.action || "").toLowerCase();

      // Check specific permissions based on action
      let hasPermission = false;
      let permissionMessage = "You do not have permission to perform this action.";

      if (action === "lock" || action === "unlock") {
        hasPermission = userCanLock(req);
        permissionMessage = "You do not have permission to lock or unlock discussions.";
      } else if (action === "sticky" || action === "unsticky") {
        hasPermission = userCanSticky(req);
        permissionMessage = "You do not have permission to pin or unpin discussions.";
      } else if (action === "archive" || action === "unarchive") {
        hasPermission = userCanArchive(req);
        permissionMessage = "You do not have permission to archive or unarchive discussions.";
      }

      if (!hasPermission) {
        setBannerCookie("danger", permissionMessage, res);
        return res.redirect(
          `/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`
        );
      }

      const updates = {};
      if (action === "lock") updates.isLocked = true;
      if (action === "unlock") updates.isLocked = false;
      if (action === "sticky") updates.isSticky = true;
      if (action === "unsticky") updates.isSticky = false;
      if (action === "archive") updates.isArchived = true;
      if (action === "unarchive") updates.isArchived = false;

      if (!Object.keys(updates).length) {
        setBannerCookie(
          "warning",
          "Unknown moderation action.",
          res
        );
        return res.redirect(
          `/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`
        );
      }

      try {
        await setDiscussionFlags(discussionId, updates);

        const actionLabels = {
          lock: "Discussion Locked",
          unlock: "Discussion Unlocked",
          sticky: "Discussion Pinned",
          unsticky: "Discussion Unpinned",
          archive: "Discussion Archived",
          unarchive: "Discussion Unarchived",
        };

        const baseUrl = getSiteBaseUrl(req);
        const username = req.session?.user?.username || "Unknown";
        const uuid = req.session?.user?.uuid;
        sendForumLog(config, {
          action,
          title: actionLabels[action] || `Discussion ${action}`,
          description: `**${result.discussion.title || `Discussion #${discussionId}`}**`,
          url: baseUrl ? `${baseUrl}/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}` : undefined,
          avatarUrl: uuid ? `https://crafthead.net/helm/${uuid}` : undefined,
          fields: [
            ["Action By", username],
          ],
        });

        setBannerCookie("success", "Discussion updated.", res);
      } catch (error) {
        console.error("[FORUMS] Failed to update discussion flags", error);
        setBannerCookie(
          "danger",
          "Unable to update the discussion state.",
          res
        );
      }

      return res.redirect(
        `/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`
      );
    }
  );

  app.post("/forums/discussion/:discussionId/move", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    const discussionId = Number.parseInt(req.params.discussionId, 10);
    const result = await getDiscussionWithCategory(discussionId);

    if (!result) {
      await renderForumsView(app, res, req, "session/notFound", { pageTitle: `404 Not Found` }, config, features);
      return;
    }

    if (!userCanModerate(req)) {
      await renderForumsView(app, res, req, "session/noPermission", { pageTitle: `Access Restricted` }, config, features);
      return;
    }

    const newCategoryId = Number.parseInt(req.body.newCategoryId, 10);
    if (!newCategoryId || newCategoryId === result.discussion.categoryId) {
      setBannerCookie("warning", "Please select a different category.", res);
      return res.redirect(`/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`);
    }

    try {
      await moveDiscussion(discussionId, newCategoryId);

      const baseUrl = getSiteBaseUrl(req);
      const username = req.session?.user?.username || "Unknown";
      const uuid = req.session?.user?.uuid;
      sendForumLog(config, {
        action: "move",
        title: "Discussion Moved",
        description: `**${result.discussion.title}** moved to a new category`,
        url: baseUrl ? `${baseUrl}/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}` : undefined,
        avatarUrl: uuid ? `https://crafthead.net/helm/${uuid}` : undefined,
        fields: [["Moved By", username]],
      });

      setBannerCookie("success", "Discussion moved to the new category.", res);
    } catch (error) {
      console.error("[FORUMS] Failed to move discussion", error);
      setBannerCookie("danger", "Unable to move the discussion.", res);
    }

    return res.redirect(`/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`);
  });

  async function handlePollVote(req, res, isChange) {
    if (!(await ensureFeature(req, res))) return;

    if (!isLoggedIn(req)) {
      setBannerCookie("warning", "You must be logged in to vote.", res);
      return res.redirect("/login");
    }

    const userId = getCurrentUserId(req);
    const discussionId = Number.parseInt(req.params.discussionId, 10);
    const result = await getDiscussionWithCategory(discussionId);

    if (!result || !userCanViewCategory(result.category, req)) {
      setBannerCookie("danger", "Discussion not found.", res);
      return res.redirect("/forums");
    }

    const redirectUrl = `/forums/discussion/${result.discussion.discussionId}/${result.discussion.slug}`;

    const poll = await getPollByDiscussionId(discussionId, userId).catch(() => null);
    if (!poll) {
      setBannerCookie("danger", "Poll not found.", res);
      return res.redirect(redirectUrl);
    }

    let rawOptionIds = req.body.optionId;
    if (!Array.isArray(rawOptionIds)) rawOptionIds = rawOptionIds ? [rawOptionIds] : [];
    const optionIds = rawOptionIds
      .map((id) => Number.parseInt(id, 10))
      .filter((id) => Number.isFinite(id) && id > 0);

    if (!optionIds.length) {
      setBannerCookie("danger", "Please select at least one option.", res);
      return res.redirect(redirectUrl);
    }

    try {
      if (isChange) {
        await changeVote(poll.pollId, userId, optionIds);
        setBannerCookie("success", "Your vote has been updated.", res);
      } else {
        await castVote(poll.pollId, userId, optionIds);
        setBannerCookie("success", "Your vote has been recorded.", res);
      }
    } catch (error) {
      setBannerCookie("danger", error.message || "Failed to record your vote.", res);
    }

    return res.redirect(redirectUrl);
  }

  app.post("/forums/discussion/:discussionId/poll/vote", (req, res) =>
    handlePollVote(req, res, false)
  );
  app.post("/forums/discussion/:discussionId/poll/vote/change", (req, res) =>
    handlePollVote(req, res, true)
  );

  app.get("/forums/post/:postId/revisions", async function (req, res) {
    if (!(await ensureFeature(req, res))) {
      return;
    }

    try {
      const postId = Number.parseInt(req.params.postId, 10);
      const post = await getPostById(postId);

      if (!post) {
        await renderForumsView(
          app,
          res,
          req,
          "session/notFound",
          {
            pageTitle: `404 Not Found`,
          },
          config,
          features
        );
        return;
      }

      const result = await getDiscussionWithCategory(post.discussionId);

      if (!result || !userCanViewCategory(result.category, req)) {
        await renderForumsView(
          app,
          res,
          req,
          "session/notFound",
          {
            pageTitle: `404 Not Found`,
          },
          config,
          features
        );
        return;
      }

      if (!userCanModerate(req)) {
        await renderForumsView(
          app,
          res,
          req,
          "session/noPermission",
          {
            pageTitle: `Access Restricted`,
          },
          config,
          features
        );
        return;
      }

      const revisions = await getPostRevisions(postId);

      const permissions = getUserPermissions(req);
      const categoryTree = await getCategoriesForUser(permissions);

      await renderForumsView(
        app,
        res,
        req,
        "modules/forums/revisions",
        {
          pageTitle: `Post Revisions`,
          categories: categoryTree.tree,
          activeCategory: result.category,
          category: result.category,
          discussion: result.discussion,
          post,
          revisions,
          moment,
        },
        config,
        features
      );
    } catch (error) {
      console.error("[FORUMS] GET /forums/post/:postId/revisions error:", error);
      if (!res.sent) throw error;
    }
    return;
  });
}
