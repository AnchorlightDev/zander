import db, { luckpermsDb } from "./databaseController.js";
import { hashEmail, isLoggedIn } from "../api/common.js";
import { plainTextExcerpt, sanitizeForumHtml } from "../lib/htmlSanitize.js";
import { emitForumEvent, FORUM_EVENTS, ORIGIN } from "../lib/forums/forumEvents.mjs";

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) {
        return reject(error);
      }

      resolve(results || []);
    });
  });
}

const LUCKPERMS_QUERY_TIMEOUT_MS = 5000;

function luckpermsQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`LuckPerms query timed out after ${LUCKPERMS_QUERY_TIMEOUT_MS}ms`));
      }
    }, LUCKPERMS_QUERY_TIMEOUT_MS);

    luckpermsDb.query(sql, params, (error, results) => {
      if (settled) return; // timeout already fired
      clearTimeout(timer);
      settled = true;

      if (error) return reject(error);
      resolve(results || []);
    });
  });
}

function slugify(value) {
  if (!value) {
    return "item";
  }

  const base = String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .replace(/[-\s]+/g, "-")
    .toLowerCase();

  return base || "item";
}

/**
 * The permissions a request's viewer has for forum access checks: their
 * LuckPerms nodes, plus "@authenticated" when logged in so a category can
 * require login by setting its viewPermission to "@authenticated".
 */
export function forumViewerPermissions(req) {
  const permissions = Array.isArray(req.session?.user?.permissions)
    ? [...req.session.user.permissions]
    : [];
  if (isLoggedIn(req)) {
    permissions.push("@authenticated");
  }
  return permissions;
}

export function permissionMatch(permissions, node) {
  if (!node) {
    return true;
  }

  if (!Array.isArray(permissions) || permissions.length === 0) {
    return false;
  }

  const target = String(node).trim().toLowerCase();
  if (!target) {
    return true;
  }

  return permissions.some((permission) => {
    if (!permission) {
      return false;
    }

    const candidate = String(permission).trim().toLowerCase();
    if (!candidate) {
      return false;
    }

    if (candidate === "*") {
      return true;
    }

    if (candidate === target) {
      return true;
    }

    if (candidate.endsWith(".*")) {
      const base = candidate.slice(0, -1);
      return target.startsWith(base);
    }

    return false;
  });
}

function mapCategoryRow(row) {
  return {
    categoryId: row.categoryId,
    parentCategoryId: row.parentCategoryId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    position: row.position ?? 0,
    viewPermission: row.viewPermission || null,
    postPermission: row.postPermission || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function fetchCategoriesRaw() {
  const rows = await query(
    `SELECT categoryId, parentCategoryId, name, slug, description, position, viewPermission, postPermission, createdAt, updatedAt
       FROM forumCategories
      ORDER BY position ASC, name ASC`
  );

  return rows.map((row) => mapCategoryRow(row));
}

function buildCategoryTree(rows, permissions = null) {
  const categories = new Map();
  rows.forEach((row) => {
    categories.set(row.categoryId, { ...row, children: [], isAccessible: true });
  });

  categories.forEach((category) => {
    if (category.parentCategoryId && categories.has(category.parentCategoryId)) {
      categories.get(category.parentCategoryId).children.push(category);
    }
  });

  const roots = [];
  categories.forEach((category) => {
    if (!category.parentCategoryId) {
      roots.push(category);
    }
  });

  const accessibleFlat = [];

  const sortChildren = (children) => {
    return children
      .sort((a, b) => {
        if (a.position === b.position) {
          return a.name.localeCompare(b.name);
        }
        return (a.position ?? 0) - (b.position ?? 0);
      })
      .map((child) => {
        child.children = sortChildren(child.children);
        return child;
      });
  };

  const filterNode = (node) => {
    node.children = sortChildren(node.children).filter((child) => filterNode(child));

    const hasAccess = permissions
      ? permissionMatch(permissions, node.viewPermission)
      : true;
    const hasAccessibleChild = node.children.length > 0;

    node.isAccessible = hasAccess;

    if (hasAccess) {
      accessibleFlat.push(node);
    }

    return hasAccess || hasAccessibleChild;
  };

  const filteredRoots = sortChildren(roots).filter((root) => filterNode(root));

  return {
    tree: filteredRoots,
    flat: accessibleFlat,
  };
}

export async function getCategoriesForUser(permissions = null) {
  const rows = await fetchCategoriesRaw();
  return buildCategoryTree(rows, permissions);
}

export async function getAllCategoriesForAdmin() {
  const rows = await fetchCategoriesRaw();
  return buildCategoryTree(rows, null);
}

export async function getCategoryBySlug(slug) {
  const [row] = await query(
    `SELECT categoryId, parentCategoryId, name, slug, description, position, viewPermission, postPermission, createdAt, updatedAt
       FROM forumCategories
      WHERE slug = ?
      LIMIT 1`,
    [slug]
  );

  return row ? mapCategoryRow(row) : null;
}

export async function getCategoryById(categoryId) {
  const [row] = await query(
    `SELECT categoryId, parentCategoryId, name, slug, description, position, viewPermission, postPermission, createdAt, updatedAt
       FROM forumCategories
      WHERE categoryId = ?
      LIMIT 1`,
    [categoryId]
  );

  return row ? mapCategoryRow(row) : null;
}

async function ensureUniqueCategorySlug(baseName, excludeCategoryId = null) {
  const baseSlug = slugify(baseName);
  let candidate = baseSlug;
  let counter = 1;

  while (true) {
    const params = [candidate];
    let queryText =
      "SELECT categoryId FROM forumCategories WHERE slug = ?";

    if (excludeCategoryId) {
      queryText += " AND categoryId <> ?";
      params.push(excludeCategoryId);
    }

    const rows = await query(`${queryText} LIMIT 1`, params);
    if (!rows.length) {
      return candidate;
    }

    counter += 1;
    candidate = `${baseSlug}-${counter}`;
  }
}

async function ensureUniqueDiscussionSlug(categoryId, baseName, excludeDiscussionId = null) {
  const baseSlug = slugify(baseName);
  let candidate = baseSlug;
  let counter = 1;
  const MAX_ITERATIONS = 100;

  while (counter <= MAX_ITERATIONS) {
    const params = [categoryId, candidate];
    let queryText =
      "SELECT discussionId FROM forumDiscussions WHERE categoryId = ? AND slug = ?";

    if (excludeDiscussionId) {
      queryText += " AND discussionId <> ?";
      params.push(excludeDiscussionId);
    }

    const rows = await query(`${queryText} LIMIT 1`, params);
    if (!rows.length) {
      return candidate;
    }

    counter += 1;
    candidate = `${baseSlug}-${counter}`;
  }

  // Fallback: append timestamp to guarantee uniqueness without infinite loop
  return `${baseSlug}-${Date.now()}`;
}

export async function createCategory({
  name,
  slug,
  description,
  parentCategoryId = null,
  position = 0,
  viewPermission = null,
  postPermission = null,
}) {
  const effectiveSlug = slug
    ? await ensureUniqueCategorySlug(slug, null)
    : await ensureUniqueCategorySlug(name, null);

  const result = await query(
    `INSERT INTO forumCategories
      (parentCategoryId, name, slug, description, position, viewPermission, postPermission)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      parentCategoryId || null,
      name,
      effectiveSlug,
      description || null,
      position ?? 0,
      viewPermission || null,
      postPermission || null,
    ]
  );

  const insertedId = result.insertId || result?.[0]?.insertId;
  return getCategoryById(insertedId);
}

export async function updateCategory(categoryId, {
  name,
  slug,
  description,
  parentCategoryId = null,
  position = 0,
  viewPermission = null,
  postPermission = null,
}) {
  const existing = await getCategoryById(categoryId);
  if (!existing) {
    return null;
  }

  let effectiveSlug = existing.slug;
  if (slug && slug !== existing.slug) {
    effectiveSlug = await ensureUniqueCategorySlug(slug, categoryId);
  } else if (!slug && name && name !== existing.name) {
    effectiveSlug = await ensureUniqueCategorySlug(name, categoryId);
  }

  await query(
    `UPDATE forumCategories
        SET parentCategoryId = ?,
            name = ?,
            slug = ?,
            description = ?,
            position = ?,
            viewPermission = ?,
            postPermission = ?,
            updatedAt = NOW()
      WHERE categoryId = ?`,
    [
      parentCategoryId || null,
      name,
      effectiveSlug,
      description || null,
      position ?? 0,
      viewPermission || null,
      postPermission || null,
      categoryId,
    ]
  );

  return getCategoryById(categoryId);
}

export async function deleteCategory(categoryId) {
  await query(`DELETE FROM forumCategories WHERE categoryId = ?`, [categoryId]);
}

function mapDiscussionRow(row) {
  if (!row) {
    return null;
  }

  return {
    discussionId: row.discussionId,
    categoryId: row.categoryId,
    title: row.title,
    slug: row.slug,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastPostAt: row.lastPostAt,
    lastPostBy: row.lastPostBy,
    isLocked: !!row.isLocked,
    isSticky: !!row.isSticky,
    isArchived: !!row.isArchived,
    status: row.status || "published",
    publishAt: row.publishAt || null,
    viewCount: Number(row.viewCount ?? 0),
    discordThreadId: row.discordThreadId || null,
    discordStarterMessageId: row.discordStarterMessageId || null,
  };
}

async function getDiscussionRow(discussionId) {
  const [row] = await query(
    `SELECT discussionId, categoryId, title, slug, createdBy, createdAt, updatedAt, lastPostAt, lastPostBy, isLocked, isSticky, isArchived, status, publishAt, viewCount,
            discordThreadId, discordStarterMessageId
       FROM forumDiscussions
      WHERE discussionId = ?
      LIMIT 1`,
    [discussionId]
  );

  return mapDiscussionRow(row);
}

export async function getDiscussionWithCategory(discussionId) {
  const [row] = await query(
    `SELECT d.discussionId,
            d.categoryId,
            d.title,
            d.slug,
            d.createdBy,
            d.createdAt,
            d.updatedAt,
            d.lastPostAt,
            d.lastPostBy,
            d.isLocked,
            d.isSticky,
            d.isArchived,
            d.status,
            d.publishAt,
            d.viewCount,
            d.discordThreadId,
            d.discordStarterMessageId,
            c.name       AS categoryName,
            c.slug       AS categorySlug,
            c.description AS categoryDescription,
            c.position   AS categoryPosition,
            c.viewPermission,
            c.postPermission,
            c.parentCategoryId
       FROM forumDiscussions d
       JOIN forumCategories c ON c.categoryId = d.categoryId
      WHERE d.discussionId = ?
      LIMIT 1`,
    [discussionId]
  );

  if (!row) {
    return null;
  }

  return {
    discussion: mapDiscussionRow(row),
    category: {
      categoryId: row.categoryId,
      parentCategoryId: row.parentCategoryId,
      name: row.categoryName,
      slug: row.categorySlug,
      description: row.categoryDescription,
      position: row.categoryPosition ?? 0,
      viewPermission: row.viewPermission || null,
      postPermission: row.postPermission || null,
    },
  };
}

async function getDiscussionBySlug(categoryId, slug) {
  const [row] = await query(
    `SELECT discussionId
       FROM forumDiscussions
      WHERE categoryId = ?
        AND slug = ?
      LIMIT 1`,
    [categoryId, slug]
  );

  return row ? row.discussionId : null;
}

async function getOriginalPost(discussionId) {
  const [row] = await query(
    `SELECT postId, discussionId, userId, content, isOriginal, createdAt, updatedAt
       FROM forumPosts
      WHERE discussionId = ?
        AND isOriginal = 1
      LIMIT 1`,
    [discussionId]
  );

  return row || null;
}

async function recordPostRevision(postId, editorId, previousContent) {
  if (!previousContent) {
    return;
  }

  await query(
    `INSERT INTO forumPostRevisions (postId, editorId, previousContent)
     VALUES (?, ?, ?)`,
    [postId, editorId || null, previousContent]
  );
}

async function recalculateDiscussionMeta(discussionId) {
  const [lastPost] = await query(
    `SELECT postId, userId, createdAt
       FROM forumPosts
      WHERE discussionId = ?
      ORDER BY createdAt DESC, postId DESC
      LIMIT 1`,
    [discussionId]
  );

  if (lastPost) {
    await query(
      `UPDATE forumDiscussions
          SET lastPostAt = ?,
              lastPostBy = ?,
              updatedAt = NOW()
        WHERE discussionId = ?`,
      [lastPost.createdAt, lastPost.userId, discussionId]
    );
  } else {
    await query(
      `UPDATE forumDiscussions
          SET lastPostAt = createdAt,
              lastPostBy = createdBy,
              updatedAt = NOW()
        WHERE discussionId = ?`,
      [discussionId]
    );
  }
}

export async function createDiscussion({
  categoryId,
  userId,
  title,
  content,
  status = "published",
  publishAt = null,
  origin = ORIGIN.WEB,
  discordThreadId = null,
  discordStarterMessageId = null,
}) {
  content = sanitizeForumHtml(content);
  const slug = await ensureUniqueDiscussionSlug(categoryId, title, null);
  const source = origin === ORIGIN.DISCORD ? "discord" : "web";

  const result = await query(
    `INSERT INTO forumDiscussions
      (categoryId, title, slug, createdBy, lastPostBy, status, publishAt, discordThreadId, discordStarterMessageId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [categoryId, title, slug, userId, userId, status, publishAt, discordThreadId, discordStarterMessageId]
  );

  const discussionId = result.insertId || result?.[0]?.insertId;

  await query(
    `INSERT INTO forumPosts
      (discussionId, userId, content, isOriginal, discordMessageId, source)
    VALUES (?, ?, ?, 1, ?, ?)`,
    [discussionId, userId, content, discordStarterMessageId, source]
  );

  await recalculateDiscussionMeta(discussionId);

  if (status === "published") {
    emitForumEvent(FORUM_EVENTS.DISCUSSION_CREATED, { discussionId, categoryId, origin });
  }

  return getDiscussionRow(discussionId);
}

export async function updateDiscussion(discussionId, { title, content, editorUserId, origin = ORIGIN.WEB }) {
  const discussion = await getDiscussionRow(discussionId);
  if (!discussion) {
    return null;
  }

  let titleChanged = false;
  let contentChanged = false;

  if (title && title !== discussion.title) {
    titleChanged = true;
    await query(
      `UPDATE forumDiscussions
          SET title = ?,
              updatedAt = NOW()
        WHERE discussionId = ?`,
      [title, discussionId]
    );
  }

  if (content !== undefined && content !== null) {
    content = sanitizeForumHtml(content);
    const originalPost = await getOriginalPost(discussionId);
    if (originalPost && originalPost.content !== content) {
      contentChanged = true;
      await recordPostRevision(originalPost.postId, editorUserId, originalPost.content);

      await query(
        `UPDATE forumPosts
            SET content = ?,
                updatedAt = NOW()
          WHERE postId = ?`,
        [content, originalPost.postId]
      );
    }
  }

  await query(
    `UPDATE forumDiscussions
        SET updatedAt = NOW()
      WHERE discussionId = ?`,
    [discussionId]
  );

  if ((titleChanged || contentChanged) && discussion.status === "published") {
    emitForumEvent(FORUM_EVENTS.DISCUSSION_UPDATED, {
      discussionId,
      categoryId: discussion.categoryId,
      titleChanged,
      contentChanged,
      origin,
    });
  }

  return getDiscussionRow(discussionId);
}

export async function deleteDiscussion(discussionId, { origin = ORIGIN.WEB } = {}) {
  const discussion = await getDiscussionRow(discussionId);
  await query(`DELETE FROM forumDiscussions WHERE discussionId = ?`, [discussionId]);
  if (discussion) {
    emitForumEvent(FORUM_EVENTS.DISCUSSION_DELETED, {
      discussionId,
      categoryId: discussion.categoryId,
      discordThreadId: discussion.discordThreadId,
      origin,
    });
  }
}

export async function moveDiscussion(discussionId, newCategoryId, { origin = ORIGIN.WEB } = {}) {
  const discussion = await getDiscussionRow(discussionId);
  await query(
    `UPDATE forumDiscussions SET categoryId = ?, updatedAt = NOW() WHERE discussionId = ?`,
    [newCategoryId, discussionId]
  );
  if (discussion && discussion.categoryId !== newCategoryId) {
    emitForumEvent(FORUM_EVENTS.DISCUSSION_MOVED, {
      discussionId,
      fromCategoryId: discussion.categoryId,
      toCategoryId: newCategoryId,
      discordThreadId: discussion.discordThreadId,
      origin,
    });
  }
}

export async function createReply({
  discussionId,
  userId,
  content,
  replyToPostId = null,
  origin = ORIGIN.WEB,
  discordMessageId = null,
}) {
  content = sanitizeForumHtml(content);
  const source = origin === ORIGIN.DISCORD ? "discord" : "web";
  const result = await query(
    `INSERT INTO forumPosts (discussionId, userId, replyToPostId, content, isOriginal, discordMessageId, source)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [discussionId, userId, replyToPostId || null, content, discordMessageId, source]
  );

  const postId = result.insertId || result?.[0]?.insertId;

  await query(
    `UPDATE forumDiscussions
        SET lastPostAt = NOW(),
            lastPostBy = ?,
            updatedAt = NOW()
      WHERE discussionId = ?`,
    [userId, discussionId]
  );

  emitForumEvent(FORUM_EVENTS.POST_CREATED, { postId, discussionId, origin });

  return postId;
}

export async function getPostById(postId) {
  const [row] = await query(
    `SELECT postId, discussionId, userId, replyToPostId, content, isOriginal, createdAt, updatedAt,
            discordMessageId, source
       FROM forumPosts
      WHERE postId = ?
      LIMIT 1`,
    [postId]
  );

  return row || null;
}

export async function updatePost(postId, { content, editorUserId, origin = ORIGIN.WEB }) {
  content = sanitizeForumHtml(content);
  const post = await getPostById(postId);
  if (!post) {
    return null;
  }

  if (content === post.content) {
    return post;
  }

  await recordPostRevision(postId, editorUserId, post.content);

  await query(
    `UPDATE forumPosts
        SET content = ?,
            updatedAt = NOW()
      WHERE postId = ?`,
    [content, postId]
  );

  await query(
    `UPDATE forumDiscussions
        SET updatedAt = NOW()
      WHERE discussionId = ?`,
    [post.discussionId]
  );

  if (!post.isOriginal) {
    await recalculateDiscussionMeta(post.discussionId);
  }

  emitForumEvent(FORUM_EVENTS.POST_UPDATED, {
    postId,
    discussionId: post.discussionId,
    isOriginal: !!post.isOriginal,
    origin,
  });

  return getPostById(postId);
}

export async function deletePost(postId, { origin = ORIGIN.WEB } = {}) {
  const post = await getPostById(postId);
  if (!post) {
    return;
  }

  await query(`DELETE FROM forumPosts WHERE postId = ?`, [postId]);

  await recalculateDiscussionMeta(post.discussionId);

  emitForumEvent(FORUM_EVENTS.POST_DELETED, {
    postId,
    discussionId: post.discussionId,
    discordMessageId: post.discordMessageId || null,
    origin,
  });
}

async function fetchUserSummaries(userIds) {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  if (!uniqueIds.length) {
    return new Map();
  }

  const placeholders = uniqueIds.map(() => "?").join(",");

  const userRows = await query(
    `SELECT userId, username, uuid, profilePicture_type, profilePicture_email
       FROM users
      WHERE userId IN (${placeholders})`,
    uniqueIds
  );

  const summaries = new Map();

  userRows.forEach((row) => {
    let avatarUrl = null;

    if (row.profilePicture_type === "GRAVATAR" && row.profilePicture_email) {
      avatarUrl = null;
    } else if (row.uuid) {
      avatarUrl = `https://crafthead.net/helm/${row.uuid}`;
    }

    summaries.set(row.userId, {
      userId: row.userId,
      username: row.username,
      uuid: row.uuid,
      avatarUrl,
      profilePictureType: row.profilePicture_type,
      profilePictureEmail: row.profilePicture_email,
      ranks: [],
    });
  });

  uniqueIds.forEach((userId) => {
    if (!summaries.has(userId)) {
      summaries.set(userId, {
        userId,
        username: "Unknown", 
        uuid: null,
        avatarUrl: "https://crafthead.net/helm/steve",
        profilePictureType: null,
        profilePictureEmail: null,
        ranks: [],
      });
    }
  });

  // Build uuid → userId map so we can correlate LuckPerms rows back to forum users
  const uuidToUserId = new Map();
  for (const summary of summaries.values()) {
    if (summary.uuid) {
      uuidToUserId.set(summary.uuid, summary.userId);
    }
  }

  // Fetch rank data from LuckPerms directly (avoids broken cross-database views)
  try {
    const uuids = Array.from(uuidToUserId.keys());
    if (uuids.length > 0) {
      const uuidPlaceholders = uuids.map(() => "?").join(",");

      // Two simple queries instead of a slow correlated self-join.
      // Query 1: group memberships (uuid → rankSlug)
      const userRankRows = await luckpermsQuery(
        `SELECT uuid, SUBSTRING_INDEX(permission, '.', -1) AS rankSlug
         FROM luckperms_user_permissions
         WHERE uuid IN (${uuidPlaceholders})
           AND permission LIKE 'group.%'
           AND value = 1`,
        uuids
      );

      // Query 2: per-rank title overrides (meta.group.<rankSlug>.title.<title>)
      const titleRows = await luckpermsQuery(
        `SELECT
           uuid,
           SUBSTRING_INDEX(SUBSTRING_INDEX(permission, '.', 3), '.', -1) AS rankSlug,
           SUBSTRING_INDEX(permission, 'title.', -1) AS title
         FROM luckperms_user_permissions
         WHERE uuid IN (${uuidPlaceholders})
           AND permission LIKE 'meta.group.%.title.%'
           AND value = 1`,
        uuids
      );

      // Build uuid:rankSlug → title map for O(1) correlation
      const titleMap = new Map();
      for (const row of titleRows) {
        titleMap.set(`${row.uuid}:${row.rankSlug}`, row.title);
      }

      // Attach title to each rank row
      for (const row of userRankRows) {
        row.title = titleMap.get(`${row.uuid}:${row.rankSlug}`) || null;
      }

      const rankSlugs = [...new Set(userRankRows.map((r) => r.rankSlug))];
      let rankInfoMap = new Map();

      if (rankSlugs.length > 0) {
        const rankPlaceholders = rankSlugs.map(() => "?").join(",");
        const rankInfoRows = await luckpermsQuery(
          `SELECT
            lpGroups.name AS rankSlug,
            COALESCE(SUBSTRING_INDEX(lpGroupDisplayName.permission, '.', -1), lpGroups.name) AS displayName,
            SUBSTRING_INDEX(lpGroupWeight.permission, '.', -1) AS priority,
            COALESCE(
              CONCAT('#', SUBSTRING_INDEX(lpMetaBadgeColour.permission, '.', -1)),
              CASE LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1)
                WHEN '0' THEN '#000000' WHEN '1' THEN '#0000AA' WHEN '2' THEN '#00AA00'
                WHEN '3' THEN '#00AAAA' WHEN '4' THEN '#AA0000' WHEN '5' THEN '#AA00AA'
                WHEN '6' THEN '#FFAA00' WHEN '7' THEN '#AAAAAA' WHEN '8' THEN '#555555'
                WHEN '9' THEN '#5555FF' WHEN 'a' THEN '#55FF55' WHEN 'b' THEN '#55FFFF'
                WHEN 'c' THEN '#FF5555' WHEN 'd' THEN '#FF55FF' WHEN 'e' THEN '#FFFF55'
                WHEN 'g' THEN '#DDD605' ELSE '#FFFFFF'
              END
            ) AS rankBadgeColour,
            COALESCE(
              CONCAT('#', SUBSTRING_INDEX(lpMetaTextColour.permission, '.', -1)),
              CASE WHEN LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1)
                IN ('0','1','2','3','4','5','8','9') THEN '#FFFFFF'
              ELSE '#000000' END
            ) AS rankTextColour
          FROM luckperms_groups lpGroups
            LEFT JOIN luckperms_group_permissions lpGroupDisplayName
              ON lpGroups.name = lpGroupDisplayName.name
              AND lpGroupDisplayName.permission LIKE 'displayname.%'
              AND lpGroupDisplayName.value = 1
            LEFT JOIN luckperms_group_permissions lpGroupWeight
              ON lpGroups.name = lpGroupWeight.name
              AND lpGroupWeight.permission LIKE 'weight.%'
              AND lpGroupWeight.value = 1
            LEFT JOIN luckperms_group_permissions lpGroupPrefix
              ON lpGroups.name = lpGroupPrefix.name
              AND lpGroupPrefix.permission LIKE 'prefix.%'
              AND lpGroupPrefix.value = 1
            LEFT JOIN luckperms_group_permissions lpMetaBadgeColour
              ON lpGroups.name = lpMetaBadgeColour.name
              AND lpMetaBadgeColour.permission LIKE 'meta.rankbadgecolour.%'
              AND lpMetaBadgeColour.value = 1
            LEFT JOIN luckperms_group_permissions lpMetaTextColour
              ON lpGroups.name = lpMetaTextColour.name
              AND lpMetaTextColour.permission LIKE 'meta.ranktextcolour.%'
              AND lpMetaTextColour.value = 1
          WHERE lpGroups.name IN (${rankPlaceholders})`,
          rankSlugs
        );

        rankInfoMap = new Map(rankInfoRows.map((r) => [r.rankSlug, r]));
      }

      // Sort by priority descending then rankSlug ascending (matching original ORDER BY)
      userRankRows.sort((a, b) => {
        const pA = parseInt(rankInfoMap.get(a.rankSlug)?.priority) || 0;
        const pB = parseInt(rankInfoMap.get(b.rankSlug)?.priority) || 0;
        if (pB !== pA) return pB - pA;
        return (a.rankSlug || "").localeCompare(b.rankSlug || "");
      });

      for (const row of userRankRows) {
        if (row.rankSlug === "default") continue;
        const userId = uuidToUserId.get(row.uuid);
        if (userId === undefined) continue;
        const summary = summaries.get(userId);
        if (!summary) continue;
        const rankInfo = rankInfoMap.get(row.rankSlug) || {};
        summary.ranks.push({
          rankSlug: row.rankSlug,
          displayName: rankInfo.displayName || row.rankSlug,
          badgeColour: rankInfo.rankBadgeColour || null,
          textColour: rankInfo.rankTextColour || null,
          title: row.title || null,
        });
      }
    }
  } catch (err) {
    console.error("[forums] Failed to load rank data from LuckPerms:", err);
    // ranks remain empty for all summaries — page still renders without rank badges
  }

  for (const summary of summaries.values()) {
    if (!summary.avatarUrl) {
      if (
        summary.profilePictureType === "GRAVATAR" &&
        summary.profilePictureEmail
      ) {
        const hash = await hashEmail(summary.profilePictureEmail.trim().toLowerCase());
        summary.avatarUrl = `https://gravatar.com/avatar/${hash}?size=300`;
      } else if (summary.uuid) {
        summary.avatarUrl = `https://crafthead.net/helm/${summary.uuid}`;
      } else {
        summary.avatarUrl = "https://crafthead.net/helm/steve";
      }
    }
  }

  return summaries;
}

export async function getDiscussionPosts(discussionId) {
  const rows = await query(
    `SELECT postId, discussionId, userId, replyToPostId, content, isOriginal, createdAt, updatedAt, source
       FROM forumPosts
      WHERE discussionId = ?
      ORDER BY createdAt ASC, postId ASC`,
    [discussionId]
  );

  const postIds = rows.map((row) => row.postId);
  const userIds = rows.map((row) => row.userId);

  const userSummaries = await fetchUserSummaries(userIds);

  let revisionRows = [];
  if (postIds.length) {
    const placeholders = postIds.map(() => "?").join(",");
    revisionRows = await query(
      `SELECT r.revisionId,
              r.postId,
              r.editorId,
              r.previousContent,
              r.createdAt,
              u.username AS editorUsername
         FROM forumPostRevisions r
         LEFT JOIN users u ON u.userId = r.editorId
        WHERE r.postId IN (${placeholders})
        ORDER BY r.createdAt DESC, r.revisionId DESC`,
      postIds
    );
  }

  const revisionsByPost = new Map();
  revisionRows.forEach((row) => {
    if (!revisionsByPost.has(row.postId)) {
      revisionsByPost.set(row.postId, []);
    }
    revisionsByPost.get(row.postId).push({
      revisionId: row.revisionId,
      editorId: row.editorId,
      editorUsername: row.editorUsername,
      previousContent: row.previousContent,
      createdAt: row.createdAt,
    });
  });

  return rows.map((row) => {
    const replyTarget = row.replyToPostId
      ? rows.find((candidate) => candidate.postId === row.replyToPostId)
      : null;
    return {
      ...row,
      isOriginal: !!row.isOriginal,
      user: userSummaries.get(row.userId) || null,
      replyTo: replyTarget ? {
        postId: replyTarget.postId,
        user: userSummaries.get(replyTarget.userId) || null,
      } : null,
      revisions: revisionsByPost.get(row.postId) || [],
    };
  });
}

export async function getRecentDiscussions({
  categoryIds = [],
  page = 1,
  perPage = 20,
  includeArchived = false,
}) {
  if (!categoryIds.length) {
    return { discussions: [], total: 0 };
  }

  const placeholders = categoryIds.map(() => "?").join(",");
  const offset = Math.max(0, (page - 1) * perPage);

  const totalRows = await query(
    `SELECT COUNT(*) AS total
       FROM forumDiscussions
      WHERE categoryId IN (${placeholders})
        AND status = 'published'
        ${includeArchived ? "" : "AND isArchived = 0"}`,
    categoryIds
  );

  const total = totalRows?.[0]?.total ? Number(totalRows[0].total) : 0;

  const rows = await query(
    `SELECT d.discussionId,
            d.categoryId,
            d.title,
            d.slug,
            d.createdBy,
            d.createdAt,
            d.updatedAt,
            d.lastPostAt,
            d.lastPostBy,
            d.isLocked,
            d.isSticky,
            d.isArchived,
            d.viewCount,
            c.name AS categoryName,
            c.slug AS categorySlug
       FROM forumDiscussions d
       JOIN forumCategories c ON c.categoryId = d.categoryId
      WHERE d.categoryId IN (${placeholders})
        AND d.status = 'published'
        ${includeArchived ? "" : "AND d.isArchived = 0"}
      ORDER BY d.isSticky DESC, d.lastPostAt DESC, d.discussionId DESC
      LIMIT ? OFFSET ?`,
    [...categoryIds, perPage, offset]
  );

  const discussionIds = rows.map((row) => row.discussionId);
  const userIds = rows.flatMap((row) => [row.createdBy, row.lastPostBy]);

  const replyCounts = new Map();
  if (discussionIds.length) {
    const discussionPlaceholders = discussionIds.map(() => "?").join(",");
    const countRows = await query(
      `SELECT discussionId, COUNT(*) AS postCount
         FROM forumPosts
        WHERE discussionId IN (${discussionPlaceholders})
        GROUP BY discussionId`,
      discussionIds
    );

    countRows.forEach((row) => {
      const replies = Math.max(0, Number(row.postCount || 0) - 1);
      replyCounts.set(row.discussionId, replies);
    });

    const lastPostRows = await query(
      `SELECT p.discussionId, p.postId, p.userId, p.createdAt
         FROM forumPosts p
        WHERE p.discussionId IN (${discussionPlaceholders})
        ORDER BY p.discussionId ASC, p.createdAt DESC, p.postId DESC`,
      discussionIds
    );

    const latestPostMap = new Map();
    lastPostRows.forEach((row) => {
      if (!latestPostMap.has(row.discussionId)) {
        latestPostMap.set(row.discussionId, row);
        userIds.push(row.userId);
      }
    });

    rows.forEach((row) => {
      const latest = latestPostMap.get(row.discussionId);
      if (latest) {
        row.latestPost = latest;
      }
    });
  }

  const userSummaries = await fetchUserSummaries(userIds);

  const discussions = rows.map((row) => {
    const author = userSummaries.get(row.createdBy) || null;
    const lastPostUserId = row.latestPost?.userId || row.lastPostBy;
    const lastPoster = lastPostUserId ? userSummaries.get(lastPostUserId) : null;

    return {
      ...mapDiscussionRow(row),
      categoryName: row.categoryName,
      categorySlug: row.categorySlug,
      replyCount: replyCounts.get(row.discussionId) ?? 0,
      latestPost: row.latestPost
        ? {
            postId: row.latestPost.postId,
            createdAt: row.latestPost.createdAt,
            user: lastPoster,
          }
        : null,
      author,
    };
  });

  return { discussions, total };
}

/**
 * The newest discussions in `categoryIds`, for the homepage: newest first by
 * when they were started, archived ones left out, and sticky ones not pinned
 * to the top (a pinned rules thread would otherwise sit there for good). Each
 * carries a plain-text excerpt of its opening post.
 *
 * `categoryIds` must already be limited to what the viewer can see -- see
 * forumViewerPermissions() and getCategoriesForUser().
 */
export async function getLatestDiscussions({ categoryIds = [], limit = 4, excerptLength = 160 } = {}) {
  if (!categoryIds.length || limit < 1) return [];

  const placeholders = categoryIds.map(() => "?").join(",");
  const rows = await query(
    `SELECT d.discussionId, d.categoryId, d.title, d.slug, d.createdBy, d.createdAt,
            d.updatedAt, d.lastPostAt, d.lastPostBy, d.isLocked, d.isSticky, d.isArchived, d.viewCount,
            c.name AS categoryName, c.slug AS categorySlug
       FROM forumDiscussions d
       JOIN forumCategories c ON c.categoryId = d.categoryId
      WHERE d.categoryId IN (${placeholders})
        AND d.isArchived = 0
        AND d.status = 'published'
      ORDER BY d.createdAt DESC, d.discussionId DESC
      LIMIT ?`,
    [...categoryIds, limit]
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.discussionId);
  const idPlaceholders = ids.map(() => "?").join(",");
  const [countRows, openingRows] = await Promise.all([
    query(
      `SELECT discussionId, COUNT(*) AS postCount
         FROM forumPosts
        WHERE discussionId IN (${idPlaceholders})
        GROUP BY discussionId`,
      ids
    ),
    // The opening post: flagged isOriginal, else the earliest
    query(
      `SELECT discussionId, content
         FROM forumPosts
        WHERE discussionId IN (${idPlaceholders})
        ORDER BY discussionId ASC, isOriginal DESC, createdAt ASC, postId ASC`,
      ids
    ),
  ]);

  const replies = new Map(countRows.map((r) => [r.discussionId, Math.max(0, Number(r.postCount || 0) - 1)]));
  const opening = new Map();
  for (const r of openingRows) if (!opening.has(r.discussionId)) opening.set(r.discussionId, r.content);

  const authors = await fetchUserSummaries(rows.map((r) => r.createdBy));

  return rows.map((row) => ({
    ...mapDiscussionRow(row),
    categoryName: row.categoryName,
    categorySlug: row.categorySlug,
    replyCount: replies.get(row.discussionId) ?? 0,
    excerpt: plainTextExcerpt(opening.get(row.discussionId), excerptLength),
    author: authors.get(row.createdBy) || null,
  }));
}

export async function getCategoryDiscussions({
  categoryId,
  page = 1,
  perPage = 20,
  includeArchived = false,
}) {
  if (!categoryId) {
    return { discussions: [], total: 0 };
  }

  return getRecentDiscussions({
    categoryIds: [categoryId],
    page,
    perPage,
    includeArchived,
  });
}

export async function setDiscussionFlags(discussionId, flags = {}, { origin = ORIGIN.WEB } = {}) {
  const updates = [];
  const params = [];

  if (flags.isLocked !== undefined) {
    updates.push("isLocked = ?");
    params.push(flags.isLocked ? 1 : 0);
  }

  if (flags.isSticky !== undefined) {
    updates.push("isSticky = ?");
    params.push(flags.isSticky ? 1 : 0);
  }

  if (flags.isArchived !== undefined) {
    updates.push("isArchived = ?");
    params.push(flags.isArchived ? 1 : 0);
  }

  if (!updates.length) {
    return getDiscussionRow(discussionId);
  }

  params.push(discussionId);

  await query(
    `UPDATE forumDiscussions
        SET ${updates.join(",")},
            updatedAt = NOW()
      WHERE discussionId = ?`,
    params
  );

  const updated = await getDiscussionRow(discussionId);
  if (updated && (flags.isLocked !== undefined || flags.isArchived !== undefined)) {
    emitForumEvent(FORUM_EVENTS.DISCUSSION_FLAGS, {
      discussionId,
      categoryId: updated.categoryId,
      isLocked: updated.isLocked,
      isArchived: updated.isArchived,
      origin,
    });
  }
  return updated;
}

/**
 * Bump a discussion's view counter by one. Best-effort and deliberately not
 * awaited on the critical path: a failed counter write must never stop the
 * thread from rendering. Deduplication (once per session) is the caller's job
 * -- see routes/forumRoutes.js -- so this just does the increment.
 */
export async function incrementDiscussionViews(discussionId) {
  const id = Number.parseInt(discussionId, 10);
  if (!Number.isFinite(id) || id <= 0) return;
  await query(
    `UPDATE forumDiscussions SET viewCount = viewCount + 1 WHERE discussionId = ?`,
    [id]
  );
}

/**
 * A user's own unpublished threads (drafts and scheduled), newest first, for the
 * "My drafts" page. Includes the category name/slug so each can link out.
 */
export async function getUserDraftDiscussions(userId) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isFinite(id) || id <= 0) return [];

  const rows = await query(
    `SELECT d.discussionId, d.categoryId, d.title, d.slug, d.createdBy, d.createdAt,
            d.updatedAt, d.lastPostAt, d.lastPostBy, d.isLocked, d.isSticky, d.isArchived,
            d.status, d.publishAt, d.viewCount,
            c.name AS categoryName, c.slug AS categorySlug
       FROM forumDiscussions d
       JOIN forumCategories c ON c.categoryId = d.categoryId
      WHERE d.createdBy = ?
        AND d.status IN ('draft','scheduled')
      ORDER BY d.updatedAt DESC, d.discussionId DESC`,
    [id]
  );

  return rows.map((row) => ({
    ...mapDiscussionRow(row),
    categoryName: row.categoryName,
    categorySlug: row.categorySlug,
  }));
}

/**
 * Publish a draft or scheduled thread now: clear the schedule and stamp its
 * post time to the moment it goes live, so it sorts in as a fresh discussion
 * rather than back-dated to when the draft was written. The original post's
 * timestamp is moved too, so "Posted ..." on the thread matches.
 */
export async function publishDiscussion(discussionId) {
  const id = Number.parseInt(discussionId, 10);
  if (!Number.isFinite(id) || id <= 0) return null;

  const publishResult = await query(
    `UPDATE forumDiscussions
        SET status = 'published',
            publishAt = NULL,
            createdAt = NOW(),
            lastPostAt = NOW(),
            updatedAt = NOW()
      WHERE discussionId = ?
        AND status IN ('draft','scheduled')`,
    [id]
  );

  await query(
    `UPDATE forumPosts
        SET createdAt = NOW(),
            updatedAt = NOW()
      WHERE discussionId = ?
        AND isOriginal = 1`,
    [id]
  );

  const published = await getDiscussionRow(id);
  const didPublish = Number(publishResult?.affectedRows ?? 0) > 0;
  if (published && didPublish) {
    emitForumEvent(FORUM_EVENTS.DISCUSSION_CREATED, {
      discussionId: id,
      categoryId: published.categoryId,
      origin: ORIGIN.WEB,
    });
  }
  return published;
}

/**
 * Publish every scheduled thread whose time has come. Called by the forum
 * scheduler cron. Returns the ids it published, so the cron can log them.
 */
export async function publishDueScheduledDiscussions() {
  const due = await query(
    `SELECT discussionId
       FROM forumDiscussions
      WHERE status = 'scheduled'
        AND publishAt IS NOT NULL
        AND publishAt <= NOW()`
  );

  const published = [];
  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop
    await publishDiscussion(row.discussionId);
    published.push(row.discussionId);
  }
  return published;
}

export async function getPostRevisions(postId) {
  return query(
    `SELECT r.revisionId,
            r.postId,
            r.editorId,
            r.previousContent,
            r.createdAt,
            u.username AS editorUsername
       FROM forumPostRevisions r
       LEFT JOIN users u ON u.userId = r.editorId
      WHERE r.postId = ?
      ORDER BY r.createdAt DESC, r.revisionId DESC`,
    [postId]
  );
}
