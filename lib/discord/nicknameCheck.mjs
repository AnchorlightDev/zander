import { EmbedBuilder } from "discord.js";
import { UserGetter } from "../../controllers/userController.js";
import db from "../../controllers/databaseController.js";
import pLimit from "p-limit";

const userGetter = new UserGetter();
const limit = pLimit(5);

/**
 * Strips special characters, underscores, spaces etc. and lowercases for comparison.
 * Applies NFKD decomposition first so that Unicode look-alikes (e.g. mathematical
 * monospace "𝚂𝚔𝚢𝚎𝚖𝚘𝚛𝚛𝚎" → "Skyemorre") and accented letters (é → e) are folded
 * to their ASCII equivalents before non-alphanumeric characters are stripped.
 */
function normalize(str) {
  return str
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks left by NFKD
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

/**
 * Strips trailing digits from a string.
 * Useful for MC names like "zAv7" or "LapisGamer05" where the core name is the important part.
 */
function stripTrailingDigits(str) {
  return str.replace(/\d+$/, "");
}

/**
 * Splits a Minecraft username into its component words.
 * Handles underscores, camelCase and PascalCase boundaries.
 * e.g. "VenomousViper" -> ["venomous", "viper"]
 *      "Yecto_FrazeI"  -> ["yecto", "frazei"]
 */
function splitNameParts(username) {
  // Split on underscores first, then split each part on camelCase boundaries
  return username
    .split(/[_\s]+/)
    .flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])/))
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 0);
}

/**
 * Checks whether two names are similar enough to be considered a match.
 */
function namesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

/**
 * Checks a single Discord name against the Minecraft username using all strategies.
 */
function checkName(normName, normMC, normMCBase, mcUsername) {
  if (!normName) return false;

  // Direct or contains match against full MC name and base (without trailing digits)
  if (namesMatch(normName, normMC)) return true;
  if (normMCBase.length >= 3 && namesMatch(normName, normMCBase)) return true;

  // Check if any word part of the MC name matches
  // e.g. "VenomousViper" splits to ["venomous", "viper"] — "venny" starts with "ven" from "venomous"
  // e.g. "Yecto_FrazeI" splits to ["yecto", "frazei"] — "yecto" matches directly
  const parts = splitNameParts(mcUsername);
  for (const part of parts) {
    if (part.length < 3) continue;
    if (namesMatch(normName, part)) return true;
  }

  // Check if the display name shares a common prefix (min 3 chars) with any MC part
  for (const part of parts) {
    if (part.length < 3) continue;
    const minLen = Math.min(normName.length, part.length, 3);
    if (normName.slice(0, minLen) === part.slice(0, minLen) && minLen >= 3) {
      // They share a 3+ char prefix — check if the shorter is at least half the longer
      const shorter = Math.min(normName.length, part.length);
      const longer = Math.max(normName.length, part.length);
      if (shorter >= longer * 0.5) return true;
    }
  }

  return false;
}

/**
 * Checks whether a Discord display name is similar enough to a Minecraft username.
 *
 * Returns true if the nickname is considered valid (similar to the MC name).
 * Checks the effective display name (server nickname → global name → username)
 * after stripping trailing digits, splitting camelCase/underscore parts,
 * and prefix matching.
 *
 * @param {string} discordDisplayName - The member's effective display name.
 * @param {string} minecraftUsername - The linked Minecraft username.
 */
export function isNicknameSimilar(discordDisplayName, minecraftUsername) {
  const normMC = normalize(minecraftUsername);
  const normMCBase = stripTrailingDigits(normMC);

  const normDisplay = normalize(discordDisplayName);
  return checkName(normDisplay, normMC, normMCBase, minecraftUsername);
}

/**
 * Gets the effective display name for a guild member.
 * Prefers the server nickname, falls back to global display name, then username.
 */
function getDisplayName(member) {
  return member.nickname || member.user.globalName || member.user.username;
}

/**
 * Builds an enforced nickname by appending the MC username in parentheses.
 * Discord nicknames have a 32-character limit, so the current name is
 * truncated if needed to make room for " (MCUsername)".
 */
function buildEnforcedNickname(currentDisplayName, minecraftUsername) {
  const suffix = ` (${minecraftUsername})`;
  const maxBase = 32 - suffix.length;

  // If the current name already ends with the suffix, no change needed
  if (currentDisplayName.endsWith(suffix)) return null;

  const base = maxBase > 0 ? currentDisplayName.slice(0, maxBase) : "";
  return `${base}${suffix}`.slice(0, 32);
}

/**
 * Attempts to set a member's nickname. Returns the error message on failure, null on success.
 */
async function setMemberNickname(member, nickname) {
  try {
    await member.setNickname(nickname, "Nickname does not match Minecraft username");
    return null;
  } catch (err) {
    console.error(
      `[NicknameCheck] Failed to set nickname for ${member.user.username} (${member.id}):`,
      err.message
    );
    return err.message || "Unknown error";
  }
}

/**
 * Checks a guild member's Discord nickname against their linked Minecraft username.
 * If the nickname does not match, enforces it by appending (MCUsername) and sends
 * a report to the configured channel.
 *
 * @param {GuildMember} member - The Discord guild member to check.
 * @param {string} reportChannelId - The channel ID to send reports to.
 * @param {string} [trigger="Nickname Change"] - What triggered this check.
 */
export async function checkAndReportNickname(member, reportChannelId, trigger = "Nickname Change") {
  try {
    const user = await userGetter.byDiscordId(member.id);

    // User has no linked account, nothing to check
    if (!user || !user.username) return;

    const displayName = getDisplayName(member);
    const minecraftUsername = user.username;

    if (isNicknameSimilar(displayName, minecraftUsername)) return;

    // Enforce the nickname
    const enforcedNickname = buildEnforcedNickname(displayName, minecraftUsername);
    let enforceError = null;
    if (enforcedNickname) {
      enforceError = await setMemberNickname(member, enforcedNickname);
    }
    const enforced = enforcedNickname && !enforceError;

    // Send report
    const channel = await member.client.channels.fetch(reportChannelId);
    if (!channel) {
      console.error(`[NicknameCheck] Could not find report channel ${reportChannelId}`);
      return;
    }

    let actionValue;
    if (enforced) {
      actionValue = `Nickname set to **${enforcedNickname}**`;
    } else if (enforceError) {
      actionValue = `Failed to update nickname: \`${enforceError}\``;
    } else {
      actionValue = "Nickname already has the correct suffix — no change needed";
    }

    const embed = new EmbedBuilder()
      .setTitle("Nickname Mismatch Enforced")
      .setColor(enforced ? "#ff9900" : "#ff3333")
      .addFields(
        { name: "Discord User", value: `<@${member.id}> (${member.user.username})`, inline: true },
        { name: "Original Name", value: displayName, inline: true },
        { name: "Minecraft Username", value: minecraftUsername, inline: true },
        { name: "Trigger", value: trigger, inline: true },
        { name: "Action", value: actionValue, inline: false }
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("[NicknameCheck] Failed to check nickname:", error);
  }
}

function getAllLinkedUsers() {
  return new Promise((resolve, reject) => {
    db.query(
      `SELECT discordId, username FROM users WHERE discordId IS NOT NULL AND username IS NOT NULL;`,
      (error, results) => {
        if (error) return reject(error);
        resolve(results || []);
      }
    );
  });
}

/**
 * Scans all linked users in the guild and returns mismatches.
 * Optionally sends report embeds to the given channel.
 *
 * @param {Client} discordClient - The Discord.js client instance.
 * @param {string} guildId - The guild to scan.
 * @param {object} [options]
 * @param {string} [options.reportChannelId] - Channel to send results to. If omitted, results are only returned.
 * @param {string} [options.title="Nickname Check"] - Title for the report embeds.
 * @returns {Promise<Array>} Array of mismatch objects.
 */
export async function runBulkNicknameCheck(discordClient, guildId, { reportChannelId = null, title = "Nickname Check" } = {}) {
  const guild = await discordClient.guilds.fetch(guildId);
  if (!guild) throw new Error("Could not fetch guild.");

  const linkedUsers = await getAllLinkedUsers();
  if (!linkedUsers.length) return [];

  const mismatches = [];

  await Promise.all(
    linkedUsers.map((user) =>
      limit(async () => {
        try {
          const member = await guild.members.fetch(user.discordId);
          if (!member || member.user.bot) return;

          const displayName =
            member.nickname || member.user.globalName || member.user.username;

          if (!isNicknameSimilar(displayName, user.username)) {
            // Enforce the nickname
            const enforcedNickname = buildEnforcedNickname(displayName, user.username);
            let enforceError = null;
            if (enforcedNickname) {
              enforceError = await setMemberNickname(member, enforcedNickname);
            }
            const enforced = enforcedNickname && !enforceError;

            mismatches.push({
              discordId: user.discordId,
              discordUsername: member.user.username,
              displayName,
              minecraftUsername: user.username,
              enforcedNickname: enforced ? enforcedNickname : null,
              enforceError,
            });
          }
        } catch (err) {
          // Member may have left the guild — error code 10007
          if (err.code !== 10007) {
            console.error(
              `[NicknameCheck] Error fetching member ${user.discordId}:`,
              err.message
            );
          }
        }
      })
    )
  );

  if (reportChannelId && mismatches.length) {
    const channel = await discordClient.channels.fetch(reportChannelId);
    if (!channel) {
      console.error(`[NicknameCheck] Could not find report channel ${reportChannelId}.`);
      return mismatches;
    }

    const FIELDS_PER_EMBED = 25;

    for (let i = 0; i < mismatches.length; i += FIELDS_PER_EMBED) {
      const batch = mismatches.slice(i, i + FIELDS_PER_EMBED);

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(
          `Found **${mismatches.length}** user(s) whose Discord name does not match their Minecraft username.`
        )
        .setColor("#ff9900")
        .setTimestamp();

      for (const m of batch) {
        const action = m.enforcedNickname
          ? `Set to: **${m.enforcedNickname}**`
          : m.enforceError
            ? `Failed to enforce: \`${m.enforceError}\``
            : `Failed to enforce`;
        embed.addFields({
          name: m.minecraftUsername,
          value: `<@${m.discordId}> (${m.discordUsername})\nWas: **${m.displayName}**\n${action}`,
          inline: true,
        });
      }

      if (mismatches.length > FIELDS_PER_EMBED) {
        embed.setFooter({
          text: `Page ${Math.floor(i / FIELDS_PER_EMBED) + 1} of ${Math.ceil(mismatches.length / FIELDS_PER_EMBED)}`,
        });
      }

      await channel.send({ embeds: [embed] });
    }
  }

  return mismatches;
}
