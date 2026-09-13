import cron from "node-cron";
import { Colors, EmbedBuilder } from "discord.js";
import { createRequire } from "module";
import db, { luckpermsDb } from "../controllers/databaseController.js";
import { client } from "../controllers/discordController.js";

const require = createRequire(import.meta.url);
const config = require("../config.json");
const features = require("../features.json");

const DAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function buildCronExpression() {
  const auditConfig = config.staffAuditReport;
  if (!auditConfig) return null;

  const day = DAY_MAP[(auditConfig.dayOfWeek || "monday").toLowerCase()];
  if (day === undefined) {
    console.error(
      `Staff audit report: invalid dayOfWeek "${auditConfig.dayOfWeek}". Use Monday-Sunday.`
    );
    return null;
  }

  const timeParts = (auditConfig.time || "12:00").split(":");
  const hour = parseInt(timeParts[0], 10);
  const minute = parseInt(timeParts[1], 10);

  if (
    isNaN(hour) || isNaN(minute) ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59
  ) {
    console.error(
      `Staff audit report: invalid time "${auditConfig.time}". Use HH:MM format.`
    );
    return null;
  }

  return `${minute} ${hour} * * ${day}`;
}


function buildMemberField(member) {
  const ts = (val) => {
    if (!val) return "_No record_";
    const t = Math.floor(new Date(val).getTime() / 1000);
    return Number.isFinite(t) ? `<t:${t}:R>` : "_No record_";
  };

  const websiteLinked = !!member.userId;
  const discordLinked = !!member.discordId;
  const lines = [];

  lines.push(discordLinked ? `<@${member.discordId}>` : "❌ No Discord linked");

  lines.push(websiteLinked
    ? `⛏️ Login ${ts(member.audit_lastMinecraftLogin)} · Chat ${ts(member.audit_lastMinecraftMessage)}`
    : "⛏️ _Not registered on website_");

  lines.push(discordLinked
    ? `💬 Chat ${ts(member.audit_lastDiscordMessage)} · 🔊 Voice ${ts(member.audit_lastDiscordVoice)}`
    : "💬 _No Discord linked_");

  lines.push(`🌐 Login ${websiteLinked ? ts(member.audit_lastWebsiteLogin) : "_not registered_"}`);

  return lines.join("\n");
}

async function fetchActiveStaff(staffGroups) {
  if (!staffGroups?.length) return [];

  // Step 1: query LP directly for UUIDs of members in any configured staff group.
  const groupPermissions = staffGroups.map((g) => `group.${g}`);
  const lpRows = await new Promise((resolve, reject) => {
    luckpermsDb.query(
      `SELECT DISTINCT uuid FROM luckperms_user_permissions
       WHERE permission IN (?) AND value = 1`,
      [groupPermissions],
      (error, results) => {
        if (error) return reject(error);
        resolve(results || []);
      }
    );
  });

  if (!lpRows.length) return [];
  const uuids = lpRows.map((r) => r.uuid);

  // Step 2: get usernames from LP for all found UUIDs.
  const lpPlayers = await new Promise((resolve, reject) => {
    luckpermsDb.query(
      `SELECT uuid, username FROM luckperms_players WHERE uuid IN (?)`,
      [uuids],
      (error, results) => {
        if (error) return reject(error);
        resolve(results || []);
      }
    );
  });
  const nameMap = Object.fromEntries(lpPlayers.map((r) => [r.uuid, r.username]));

  // Step 3: get website/audit data from main DB for any matched users.
  const websiteRows = await new Promise((resolve, reject) => {
    db.query(
      `SELECT
        userId,
        uuid,
        discordId,
        audit_lastDiscordMessage,
        audit_lastDiscordVoice,
        audit_lastMinecraftLogin,
        audit_lastMinecraftMessage,
        audit_lastWebsiteLogin
      FROM users
      WHERE uuid IN (?) AND account_disabled = 0`,
      [uuids],
      (error, results) => {
        if (error) return reject(error);
        resolve(results || []);
      }
    );
  });
  const websiteMap = Object.fromEntries(websiteRows.map((r) => [r.uuid, r]));

  // Merge: one entry per UUID, LP username + website audit data where available.
  return uuids
    .map((uuid) => ({
      uuid,
      username: nameMap[uuid] ?? uuid,
      ...websiteMap[uuid],
    }))
    .sort((a, b) => a.username.localeCompare(b.username));
}


export async function runStaffAuditReport() {
  // Check feature flag
  if (!features.staffAuditReport) {
    return { sent: false, reason: "Feature is disabled." };
  }

  const auditConfig = config.staffAuditReport;
  if (!auditConfig?.enabled) {
    return { sent: false, reason: "Staff audit report is not enabled in config." };
  }

  // Support both flat channelId and legacy delivery.channelId
  const channelId = auditConfig.channelId || auditConfig.delivery?.channelId;
  if (!channelId) {
    console.warn("Staff audit report skipped: no channelId configured.");
    return { sent: false, reason: "No `channelId` is configured for the staff audit report." };
  }

  const staffGroups = auditConfig.staffGroups;
  if (!staffGroups?.length) {
    return { sent: false, reason: "No `staffGroups` are configured. Add a list of LP group names e.g. `\"staffGroups\": [\"mod\", \"admin\"]`." };
  }

  // Fetch staff data
  const staffMembers = await fetchActiveStaff(staffGroups);

  if (!staffMembers.length) {
    console.warn("Staff audit report skipped: no active staff members found.");
    return { sent: false, reason: "No active staff members were found." };
  }

  // Each member gets their own named field. Discord allows max 25 fields per
  // embed, so split into multiple embeds if there are more than 25 staff.
  const embeds = [];
  let embedIndex = 1;
  let currentEmbed = new EmbedBuilder()
    .setTitle("Weekly Staff Activity Audit")
    .setColor(Colors.Blurple)
    .setTimestamp(new Date());
  let fieldCount = 0;

  for (const member of staffMembers) {
    if (fieldCount >= 25) {
      embeds.push(currentEmbed);
      embedIndex++;
      currentEmbed = new EmbedBuilder()
        .setTitle(`Weekly Staff Activity Audit (cont. ${embedIndex})`)
        .setColor(Colors.Blurple)
        .setTimestamp(new Date());
      fieldCount = 0;
    }

    currentEmbed.addFields({
      name: member.username,
      value: buildMemberField(member),
      inline: false,
    });
    fieldCount++;
  }

  currentEmbed.setFooter({ text: `${staffMembers.length} active staff members` });
  embeds.push(currentEmbed);

  const channel = await client.channels.fetch(channelId);
  for (const embed of embeds) {
    await channel.send({ embeds: [embed] });
  }

  console.log(
    `Posted weekly staff audit report (${staffMembers.length} staff members, ${embeds.length} embed(s)).`
  );

  return { sent: true, staffCount: staffMembers.length, embedCount: embeds.length };
}

// Build schedule from config
const cronExpression = buildCronExpression();

if (cronExpression) {
  let timezone = config.staffAuditReport?.timezone || "UTC";

  // Validate the timezone is a valid IANA identifier
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    console.warn(
      `Invalid timezone "${timezone}" in staffAuditReport config. Falling back to UTC. Use IANA timezone names like "Australia/Sydney" instead of abbreviations like "AEDT".`
    );
    timezone = "UTC";
  }

  const staffAuditReportTask = cron.schedule(
    cronExpression,
    async () => {
      try {
        await runStaffAuditReport();
      } catch (error) {
        console.error("Failed to generate staff audit report:", error);
      }
    },
    { timezone }
  );

  staffAuditReportTask.start();

  console.log(
    `Staff audit report scheduled: "${cronExpression}" (${config.staffAuditReport?.dayOfWeek} ${config.staffAuditReport?.time} ${timezone})`
  );
} else if (config.staffAuditReport?.enabled && features.staffAuditReport) {
  console.warn(
    "Staff audit report is enabled but could not build a valid cron schedule. Check config.staffAuditReport settings."
  );
}
