/**
 * services/formRequirementsService.js
 *
 * Gathers the numbers a form's eligibility rules are compared against.
 *
 * Split from lib/formRequirements.mjs on purpose: the rules are pure
 * arithmetic and live there, unit-testable against fabricated values; all the
 * awkward parts -- four LiteBans tables on a separate MySQL instance, undashed
 * UUIDs, unix-millisecond timestamps, a Discord account that may not be linked
 * -- live here.
 *
 * Only what a form actually asks for is queried. A form with no punishment rule
 * never touches the LiteBans instance, so an unrelated outage there cannot stop
 * people filling in an unrelated form.
 */

import db, { prisma, punishmentsDb } from "../controllers/databaseController.js";
import {
  getDiscordActivitySince,
  getDiscordTrackingStart,
} from "../controllers/discordActivityController.js";
import { getUserPlaytimeSeconds } from "../controllers/userController.js";
import {
  DEFAULT_WINDOW_DAYS,
  evaluateRequirements,
  normaliseRequirements,
  windowStart,
} from "../lib/formRequirements.mjs";

/**
 * Which LiteBans tables count as "a punishment" for a clean-record rule.
 *
 * DECISION, worth revisiting: bans and mutes only. Kicks are routinely
 * automated (AFK sweeps, anti-cheat false positives, restarts) and warnings are
 * often a first-line "please stop" rather than a mark against someone -- so
 * counting either would block a large share of ordinary players from applying,
 * which is a worse failure than letting a warned player apply and be judged by
 * a human. Add "litebans_kicks" / "litebans_warnings" here to change that; the
 * rest of the query needs no edit.
 */
const PUNISHMENT_TABLES = ["litebans_bans", "litebans_mutes"];

const mainQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results);
    });
  });

const punishmentsQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    punishmentsDb.query(sql, params, (error, results) => {
      if (error) return reject(error);
      resolve(results);
    });
  });

/**
 * Minecraft punishments since `since`.
 *
 * Two LiteBans quirks, both load-bearing:
 *
 *   1. UUIDs may be stored with or without dashes depending on which plugin
 *      version wrote the row, so both sides are normalised to undashed
 *      lowercase before comparing.
 *   2. `time` is unix milliseconds, not a DATETIME. Compared as a number
 *      rather than run through FROM_UNIXTIME, which keeps the comparison off
 *      the wrong side of a timezone conversion.
 *
 * A narrow COUNT rather than the 50-row detail fetch in profileService: the
 * rule only needs to know whether the number is zero.
 */
export async function countMinecraftPunishments(uuid, since) {
  if (!uuid) return 0;

  const normalised = String(uuid).replace(/-/g, "").toLowerCase();
  const union = PUNISHMENT_TABLES.map((table) => `SELECT uuid, time FROM ${table}`).join(
    "\n           UNION ALL\n           "
  );

  const rows = await punishmentsQuery(
    `SELECT COUNT(*) AS total
     FROM (
           ${union}
     ) AS punishments
     WHERE REPLACE(punishments.uuid, '-', '') = ? AND punishments.time >= ?`,
    [normalised, since.getTime()]
  );

  return Number(rows?.[0]?.total ?? 0) || 0;
}

/**
 * Discord punishments since `since`.
 *
 * Note this is every punishment issued in the window, not only the ones still
 * active -- discordPunishmentController.getActivePunishments answers a
 * different question and would let a served, expired ban read as a clean
 * record.
 */
export async function countDiscordPunishments(discordId, since) {
  if (!discordId) return 0;

  return prisma.discord_punishments.count({
    where: {
      target_discord_user_id: String(discordId),
      created_at: { gte: since },
    },
  });
}

/** Distinct days with a game session since `since`. */
export async function countMinecraftActiveDays(userId, since) {
  const rows = await mainQuery(
    `SELECT COUNT(DISTINCT DATE(sessionStart)) AS activeDays
     FROM gameSessions WHERE userId = ? AND sessionStart >= ?`,
    [userId, since]
  );

  return Number(rows?.[0]?.activeDays ?? 0) || 0;
}

/** uuid and discordId for a user, read fresh rather than trusted from session. */
async function getIdentity(userId) {
  return prisma.users.findUnique({
    where: { userId: Number(userId) },
    select: { userId: true, uuid: true, discordId: true },
  });
}

/**
 * Measure one user against one form's rules.
 *
 * Returns the `measured` object evaluateRequirements expects. Every lookup is
 * skipped unless a rule needs it.
 */
export async function measureUser(userId, requirements, now = new Date()) {
  const rules = normaliseRequirements(requirements);
  if (!rules) return {};

  const identity = await getIdentity(userId);
  const measured = { discordLinked: Boolean(identity?.discordId) };

  const jobs = [];

  if (rules.minPlaytimeHours !== undefined) {
    jobs.push(
      getUserPlaytimeSeconds(userId).then((seconds) => {
        measured.playtimeSeconds = seconds;
      })
    );
  }

  if (rules.noPunishmentsDays !== undefined) {
    const since = windowStart(rules.noPunishmentsDays, now);
    jobs.push(
      (async () => {
        const minecraft = await countMinecraftPunishments(identity?.uuid, since);
        // Only half the check applies when there is no Discord to check --
        // skipped rather than treated as a failure, since not linking Discord
        // is not a punishment.
        const discord = identity?.discordId
          ? await countDiscordPunishments(identity.discordId, since)
          : 0;
        measured.punishmentCount = minecraft + discord;
      })()
    );
  }

  if (rules.minMinecraftActiveDays !== undefined) {
    const since = windowStart(rules.minMinecraftActiveWindowDays ?? DEFAULT_WINDOW_DAYS, now);
    jobs.push(
      countMinecraftActiveDays(userId, since).then((days) => {
        measured.minecraftActiveDays = days;
      })
    );
  }

  const wantsDiscord =
    rules.minDiscordActiveDays !== undefined || rules.minDiscordMessages !== undefined;

  if (wantsDiscord) {
    const since = windowStart(rules.minDiscordActiveWindowDays ?? DEFAULT_WINDOW_DAYS, now);
    jobs.push(
      (async () => {
        measured.discordDataFrom = await getDiscordTrackingStart();
        if (!identity?.discordId) return;
        const activity = await getDiscordActivitySince(identity.discordId, since);
        measured.discordActiveDays = activity.activeDays;
        measured.discordMessages = activity.messages;
      })()
    );
  }

  await Promise.all(jobs);
  return measured;
}

/**
 * Whether this user may fill in this form, with the per-check detail.
 *
 * Returns { ok, checks }. A form with no rules returns ok with no checks, so
 * callers can use this unconditionally.
 *
 * A lookup that throws is not a reason to block someone: an unreachable
 * LiteBans instance would otherwise turn "no punishments" into "nobody may
 * apply". The failure is logged and the gate opens.
 */
export async function checkRequirements(form, userId, now = new Date()) {
  if (!normaliseRequirements(form?.requirements)) return { ok: true, checks: [] };

  try {
    const measured = await measureUser(userId, form.requirements, now);
    return evaluateRequirements(form.requirements, measured, { now });
  } catch (error) {
    console.error(
      `[forms] Requirement check failed for form ${form?.formId} / user ${userId}:`,
      error.message
    );
    return { ok: true, checks: [], unavailable: true };
  }
}
