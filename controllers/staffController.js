import { hashEmail } from "../api/common.js";
import db from "./databaseController.js";
import { luckpermsDb } from "./databaseController.js";

/**
 * Generates a profile picture URL based on user data.
 * Uses Craftatar for Minecraft skins or Gravatar for email-based avatars.
 * Falls back to mc-heads if no profile picture type is set.
 */
async function toAvatarUrl(row) {
  const pictureType = row.profilePicture_type;

  if (pictureType === "CRAFTATAR" && row.uuid) {
    // Use /avatar/ to include skin overlay (hat layer)
    return `https://crafthead.net/avatar/${row.uuid}`;
  }

  if (pictureType === "GRAVATAR" && row.profilePicture_email) {
    const emailHash = await hashEmail(row.profilePicture_email);
    return `https://gravatar.com/avatar/${emailHash}?size=300`;
  }

  // Default fallback to crafthead using UUID or mc-heads using username
  // Both include overlay layer
  if (row.uuid) {
    return `https://crafthead.net/avatar/${row.uuid}`;
  }

  return `https://mc-heads.net/avatar/${row.username}/128`;
}

/**
 * Generates a profile URL for a user.
 * @param {string} username - The username to generate a profile URL for
 * @returns {string} The profile URL
 */
function toProfileUrl(username) {
  return `/profile/${encodeURIComponent(username)}`;
}

/**
 * Queries the LuckPerms database directly for all staff ranks.
 * Replicates the logic of the `ranks` cross-database view using LUCKPERMS_URL.
 */
async function fetchLuckPermsRanks() {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(
      `SELECT
        lpGroups.name AS rankSlug,
        COALESCE(SUBSTRING_INDEX(lpGroupDisplayName.permission, '.', -1), lpGroups.name) AS displayName,
        SUBSTRING_INDEX(lpGroupWeight.permission, '.', -1) AS priority,
        COALESCE(
          CONCAT('#', SUBSTRING_INDEX(lpMetaBadgeColour.permission, '.', -1)),
          CASE LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1)
            WHEN '0' THEN '#000000'
            WHEN '1' THEN '#0000AA'
            WHEN '2' THEN '#00AA00'
            WHEN '3' THEN '#00AAAA'
            WHEN '4' THEN '#AA0000'
            WHEN '5' THEN '#AA00AA'
            WHEN '6' THEN '#FFAA00'
            WHEN '7' THEN '#AAAAAA'
            WHEN '8' THEN '#555555'
            WHEN '9' THEN '#5555FF'
            WHEN 'a' THEN '#55FF55'
            WHEN 'b' THEN '#55FFFF'
            WHEN 'c' THEN '#FF5555'
            WHEN 'd' THEN '#FF55FF'
            WHEN 'e' THEN '#FFFF55'
            WHEN 'g' THEN '#DDD605'
            ELSE '#FFFFFF'
          END
        ) AS rankBadgeColour,
        COALESCE(
          CONCAT('#', SUBSTRING_INDEX(lpMetaTextColour.permission, '.', -1)),
          CASE WHEN
            LEFT(SUBSTRING_INDEX(lpGroupPrefix.permission, '[&', -1), 1) IN ('0','1','2','3','4','5','8','9') THEN '#FFFFFF'
            ELSE '#000000'
          END
        ) AS rankTextColour,
        COALESCE(RIGHT(lpGroupStaff.permission, 1), '0') AS isStaff,
        COALESCE(RIGHT(lpGroupDonator.permission, 1), '0') AS isDonator,
        REPLACE(COALESCE(SUBSTRING_INDEX(lpGroupDescription.permission, 'meta.rank_description.', -1), ''), '\\\\', '') AS rankDescription
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
        LEFT JOIN luckperms_group_permissions lpGroupStaff
          ON lpGroups.name = lpGroupStaff.name
          AND lpGroupStaff.permission LIKE 'meta.staff.%'
          AND lpGroupStaff.value = 1
        LEFT JOIN luckperms_group_permissions lpGroupDonator
          ON lpGroups.name = lpGroupDonator.name
          AND lpGroupDonator.permission LIKE 'meta.donator.%'
          AND lpGroupDonator.value = 1
        LEFT JOIN luckperms_group_permissions lpGroupDescription
          ON lpGroups.name = lpGroupDescription.name
          AND lpGroupDescription.permission LIKE 'meta.rank\\_description.%'
          AND lpGroupDescription.value = 1
        LEFT JOIN luckperms_group_permissions lpMetaBadgeColour
          ON lpGroups.name = lpMetaBadgeColour.name
          AND lpMetaBadgeColour.permission LIKE 'meta.rankbadgecolour.%'
          AND lpMetaBadgeColour.value = 1
        LEFT JOIN luckperms_group_permissions lpMetaTextColour
          ON lpGroups.name = lpMetaTextColour.name
          AND lpMetaTextColour.permission LIKE 'meta.ranktextcolour.%'
          AND lpMetaTextColour.value = 1`,
      function (error, results) {
        if (error) return reject(error);
        resolve(results || []);
      }
    );
  });
}

/**
 * Queries the LuckPerms database directly for user-rank assignments.
 * Replicates the logic of the `userRanks` cross-database view using LUCKPERMS_URL.
 * Returns rows with uuid, rankSlug, and title.
 */
async function fetchLuckPermsUserRanks() {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(
      `SELECT
        lup.uuid,
        SUBSTRING_INDEX(lup.permission, '.', -1) AS rankSlug,
        SUBSTRING_INDEX(lpUserTitle.permission, 'title.', -1) AS title
      FROM luckperms_user_permissions lup
        LEFT JOIN luckperms_user_permissions lpUserTitle
          ON lup.uuid = lpUserTitle.uuid
          AND lpUserTitle.permission LIKE CONCAT('meta.group\\\\.', SUBSTRING_INDEX(lup.permission, '.', -1), '\\\\.title.%')
          AND lpUserTitle.value = 1
      WHERE lup.permission LIKE 'group.%'
        AND lup.value = 1`,
      function (error, results) {
        if (error) return reject(error);
        resolve(results || []);
      }
    );
  });
}

/**
 * Queries the LuckPerms database directly for player username mappings.
 * Replicates the `luckPermsPlayers` view using LUCKPERMS_URL.
 */
async function fetchLuckPermsPlayers() {
  return new Promise((resolve, reject) => {
    luckpermsDb.query(
      `SELECT uuid, username FROM luckperms_players`,
      function (error, results) {
        if (error) return reject(error);
        resolve(results || []);
      }
    );
  });
}

/**
 * Queries the main database for user profile data (avatar, etc.) by UUIDs.
 */
async function fetchUserProfiles(uuids) {
  if (!uuids || uuids.length === 0) return [];
  return new Promise((resolve, reject) => {
    db.query(
      `SELECT uuid, username, profilePicture_type, profilePicture_email
       FROM users
       WHERE uuid IN (?)`,
      [uuids],
      function (error, results) {
        if (error) return reject(error);
        resolve(results || []);
      }
    );
  });
}

/**
 * Fetches all staff page data including active staff ranks, users, and retired staff.
 * Queries LuckPerms directly via LUCKPERMS_URL instead of cross-database views.
 * Returns data structured for the staff.ejs view template.
 */
export async function getStaffPageData() {
  // 1) Fetch all ranks from LuckPerms directly
  const allRanksRaw = await fetchLuckPermsRanks();

  // Filter to staff ranks, excluding default/retired/donator
  const ranks = allRanksRaw
    .filter(
      (r) =>
        r.isStaff == 1 &&
        r.isDonator == 0 &&
        r.rankSlug !== "default" &&
        r.rankSlug !== "retired"
    )
    .sort((a, b) => (parseInt(b.priority) || 0) - (parseInt(a.priority) || 0))
    .map((r) => ({
      ...r,
      description: r.rankDescription || "",
    }));

  // Build a set of all staff rank slugs (including retired) for filtering
  const staffRankSlugs = new Set(
    allRanksRaw
      .filter((r) => r.isStaff == 1 && r.isDonator == 0)
      .map((r) => r.rankSlug)
  );
  staffRankSlugs.add("retired");

  // 2) Fetch user-rank assignments and player usernames from LuckPerms
  let userRanksRaw = [];
  let lpPlayers = [];
  try {
    [userRanksRaw, lpPlayers] = await Promise.all([
      fetchLuckPermsUserRanks(),
      fetchLuckPermsPlayers(),
    ]);
  } catch (err) {
    console.error("[staff] Failed to load LuckPerms user/player data:", err);
  }

  // Build lookup maps
  const lpPlayerByUuid = new Map(lpPlayers.map((p) => [p.uuid, p.username]));

  // Collect all UUIDs that appear in staff/retired ranks
  const staffUuids = [
    ...new Set(
      userRanksRaw
        .filter((ur) => staffRankSlugs.has(ur.rankSlug))
        .map((ur) => ur.uuid)
    ),
  ];

  // 3) Fetch profile data from main DB for those UUIDs
  let mainDbUsers = [];
  try {
    mainDbUsers = await fetchUserProfiles(staffUuids);
  } catch (err) {
    console.error("[staff] Failed to load user profiles:", err);
  }

  const mainUserByUuid = new Map(mainDbUsers.map((u) => [u.uuid, u]));

  // Build rank priority map for sorting
  const rankPriorityBySlug = new Map(
    allRanksRaw.map((r) => [r.rankSlug, parseInt(r.priority) || 0])
  );

  // 4) Build active staff entries
  const activeStaffRankSlugs = new Set(ranks.map((r) => r.rankSlug));

  const rankUsersRaw = userRanksRaw.filter((ur) =>
    activeStaffRankSlugs.has(ur.rankSlug)
  );

  const rankUsers = await Promise.all(
    rankUsersRaw
      .sort((a, b) => {
        const pDiff =
          (rankPriorityBySlug.get(b.rankSlug) || 0) -
          (rankPriorityBySlug.get(a.rankSlug) || 0);
        if (pDiff !== 0) return pDiff;
        const usernameA = (
          mainUserByUuid.get(a.uuid)?.username ||
          lpPlayerByUuid.get(a.uuid) ||
          ""
        ).toLowerCase();
        const usernameB = (
          mainUserByUuid.get(b.uuid)?.username ||
          lpPlayerByUuid.get(b.uuid) ||
          ""
        ).toLowerCase();
        return usernameA.localeCompare(usernameB);
      })
      .map(async (ur) => {
        const mainUser = mainUserByUuid.get(ur.uuid) || null;
        const username =
          mainUser?.username || lpPlayerByUuid.get(ur.uuid) || ur.uuid;
        const avatarRow = {
          uuid: ur.uuid,
          username,
          profilePicture_type: mainUser?.profilePicture_type || null,
          profilePicture_email: mainUser?.profilePicture_email || null,
        };
        return {
          rankSlug: ur.rankSlug,
          username,
          title: ur.title || "",
          profilePicture: await toAvatarUrl(avatarRow),
          profileUrl: toProfileUrl(username),
        };
      })
  );

  // 5) Build retired staff entries
  const retiredRaw = userRanksRaw.filter((ur) => ur.rankSlug === "retired");

  const retiredUsers = await Promise.all(
    retiredRaw
      .sort((a, b) => {
        const usernameA = (
          mainUserByUuid.get(a.uuid)?.username ||
          lpPlayerByUuid.get(a.uuid) ||
          ""
        ).toLowerCase();
        const usernameB = (
          mainUserByUuid.get(b.uuid)?.username ||
          lpPlayerByUuid.get(b.uuid) ||
          ""
        ).toLowerCase();
        return usernameA.localeCompare(usernameB);
      })
      .map(async (ur) => {
        const mainUser = mainUserByUuid.get(ur.uuid) || null;
        const username =
          mainUser?.username || lpPlayerByUuid.get(ur.uuid) || ur.uuid;
        const avatarRow = {
          uuid: ur.uuid,
          username,
          profilePicture_type: mainUser?.profilePicture_type || null,
          profilePicture_email: mainUser?.profilePicture_email || null,
        };
        return {
          rankSlug: "retired",
          username,
          title: ur.title || "",
          profilePicture: await toAvatarUrl(avatarRow),
          profileUrl: toProfileUrl(username),
        };
      })
  );

  return {
    ranks,
    rankUsers,
    retiredUsers,
  };
}
