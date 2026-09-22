/**
 * cron/birthdayRankCron.js
 *
 * Grants a temporary rank on a user's birthday.
 *
 * Hourly rather than daily, because midnight is not one instant -- it arrives
 * 24 times, and a user in Auckland and a user in Los Angeles have their
 * birthday nearly a day apart. `birthdayLastGrantedYear` is what keeps an
 * hourly job from granting 24 times.
 *
 * The rank is granted with LuckPerms' `parent addtemp`, so it expires on its
 * own. There is deliberately no revoke job: a revoke job that fails, or a site
 * that is down the next morning, would leave the rank on forever. Letting
 * LuckPerms own the expiry means the only way it sticks is if LuckPerms itself
 * stops working.
 *
 * Gated in here rather than in app.js, per the convention for this folder.
 */

import cron from "node-cron";
import { Colors } from "discord.js";
import { MessageBuilder, Webhook } from "discord-webhook-node";
import { createRequire } from "module";
import db from "../controllers/databaseController.js";
import { shouldGrantBirthday, formatBirthday } from "../lib/birthday.mjs";
import { sendWebhookMessage } from "../lib/discord/webhooks.mjs";

const require = createRequire(import.meta.url);
const config = require("../config.json");

const settings = config.birthday || {};
const RANK_GROUP = String(settings.rankGroup || "").trim();
const ENABLED = settings.enabled === true && RANK_GROUP.length > 0;

const query = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results || []);
    });
  });

/**
 * Narrow the table down before doing per-user timezone maths.
 *
 * Any user whose birthday is "today" somewhere is within a day of today in
 * UTC, so three dates cover every zone. 29 February is always included: a user
 * born then celebrates on the 28th in common years, so their stored day never
 * equals the celebrated one and a plain month/day match would skip them.
 */
function candidateDates(now) {
  const dates = [];
  for (const offset of [-1, 0, 1]) {
    const d = new Date(now.getTime() + offset * 86400000);
    dates.push([d.getUTCMonth() + 1, d.getUTCDate()]);
  }
  dates.push([2, 29]);
  return dates;
}

async function findBirthdayUsers(now) {
  const dates = candidateDates(now);
  const where = dates.map(() => "(birthdayMonth = ? AND birthdayDay = ?)").join(" OR ");
  const params = dates.flat();

  const rows = await query(
    `SELECT userId, username, timezone, birthdayDay, birthdayMonth, birthdayLastGrantedYear
       FROM users
      WHERE account_disabled = 0
        AND birthdayDay IS NOT NULL
        AND birthdayMonth IS NOT NULL
        AND (${where})`,
    params
  );

  // The SQL is only a coarse filter; this is the part that actually knows
  // about the user's own timezone and the 29 February rule.
  return rows.filter((user) => shouldGrantBirthday(user, { now }));
}

/**
 * Queue the grant as a console command for zander-addon to run.
 *
 * `addtemp` with `accumulate` so that re-running today -- which should not
 * happen, but might after a manual database edit -- extends rather than
 * stacking a second membership.
 */
async function grantRank(user) {
  const hours = Number(settings.durationHours) > 0 ? Math.round(Number(settings.durationHours)) : 24;
  const command = `lp user ${user.username} parent addtemp ${RANK_GROUP} ${hours}h accumulate`;

  await query(
    `INSERT INTO executorTasks (slug, command, status, priority, metadata, createdAt, updatedAt)
     VALUES (?, ?, 'pending', 5, ?, NOW(), NOW())`,
    [
      String(settings.serverSlug || "any"),
      command,
      JSON.stringify({ source: "birthday", userId: user.userId, rankGroup: RANK_GROUP }),
    ]
  );
}

/**
 * Stamp the year before announcing.
 *
 * Order matters: if the webhook throws, the rank has already been queued, and
 * marking it first means the next hourly run does not queue it again.
 */
async function markGranted(user, year) {
  await query(`UPDATE users SET birthdayLastGrantedYear = ? WHERE userId = ?`, [year, user.userId]);
}

async function announce(user) {
  const webhookUrl = String(settings.webhookUrl || "").trim();
  if (!webhookUrl) return;

  const siteName = config.siteConfiguration?.siteName || "the server";

  // Same shape as cron/cakeDayUserCheck.js: a Webhook object and a
  // MessageBuilder, not a URL and a plain payload.
  const embed = new MessageBuilder()
    .setTitle("\u{1F382} Happy birthday, " + user.username + "!")
    .setDescription("From everyone at " + siteName + ".")
    .setColor(Colors.Blurple);

  await sendWebhookMessage(new Webhook(webhookUrl), embed, {
    context: "cron/birthdayRankCron",
  });
}

export async function runBirthdayRankCheck(now = new Date()) {
  const users = await findBirthdayUsers(now);
  if (!users.length) return { granted: 0 };

  let granted = 0;

  for (const user of users) {
    try {
      // The local year, not the UTC one -- 1 January in Brisbane is still
      // 31 December in UTC, and the stamp has to match what the check reads.
      const year = Number(
        new Intl.DateTimeFormat("en-CA", { timeZone: user.timezone || "UTC", year: "numeric" })
          .format(now)
      );

      // eslint-disable-next-line no-await-in-loop
      await grantRank(user);
      // eslint-disable-next-line no-await-in-loop
      await markGranted(user, year);
      granted += 1;

      // Best effort: the rank is the point, the announcement is a nicety.
      // eslint-disable-next-line no-await-in-loop
      await announce(user).catch((error) =>
        console.error(`[BirthdayRank] Announcement failed for ${user.username}:`, error.message)
      );

      console.log(
        `[BirthdayRank] Granted ${RANK_GROUP} to ${user.username} (${formatBirthday(
          { day: user.birthdayDay, month: user.birthdayMonth }
        )}).`
      );
    } catch (error) {
      console.error(`[BirthdayRank] Failed for ${user.username}:`, error.message);
    }
  }

  return { granted };
}

if (ENABLED) {
  cron.schedule("5 * * * *", async () => {
    try {
      await runBirthdayRankCheck(new Date());
    } catch (error) {
      console.error("[BirthdayRank] Run failed:", error.message);
    }
  });
  console.info(`[BirthdayRank] Hourly birthday rank check enabled (group: ${RANK_GROUP}).`);
} else if (settings.enabled === true) {
  console.warn("[BirthdayRank] Enabled but no `rankGroup` is configured; doing nothing.");
}
