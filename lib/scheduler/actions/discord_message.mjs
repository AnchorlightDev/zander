/**
 * discord_message action: post an embed to a Discord channel.
 * payload: { channelId, embedTitle, embedDescription (HTML), embedColor }
 * Uses the shared embed builder. If the client is not ready it fails with a clear
 * message rather than silently skipping.
 */
import { buildScheduledEmbed } from "../../discord/scheduledEmbed.mjs";

export function validate(payload = {}) {
  const errors = [];
  if (!payload.channelId || !String(payload.channelId).trim()) errors.push("discord_message: a channelId is required.");
  if (!String(payload.embedTitle ?? "").trim() && !String(payload.embedDescription ?? "").trim()) {
    errors.push("discord_message: a title or description is required.");
  }
  return errors;
}

export function describe(payload = {}) {
  return `Post a Discord embed${payload.embedTitle ? ` "${payload.embedTitle}"` : ""} to channel ${payload.channelId}`;
}

export function preview(payload = {}) {
  const embed = buildScheduledEmbed({
    title: payload.embedTitle,
    descriptionHtml: payload.embedDescription,
    color: payload.embedColor,
  });
  const data = embed.toJSON ? embed.toJSON() : {};
  return {
    summary: describe(payload),
    embed: { title: data.title, description: data.description, color: data.color },
    sideEffects: [`Sends one embed to channel ${payload.channelId}.`],
  };
}

export async function run(payload = {}, ctx = {}) {
  const client = ctx.client;
  if (!client || !client.isReady?.()) {
    return { status: "failed", message: "Discord client is not ready; the embed was not sent." };
  }
  let channel;
  try {
    channel = await client.channels.fetch(payload.channelId);
  } catch {
    return { status: "failed", message: `Channel ${payload.channelId} could not be fetched.` };
  }
  if (!channel?.isTextBased?.()) {
    return { status: "failed", message: `Channel ${payload.channelId} is not text-based.` };
  }
  const embed = buildScheduledEmbed({
    title: payload.embedTitle,
    descriptionHtml: payload.embedDescription,
    color: payload.embedColor,
    footerText: `Scheduled by ${ctx.actorUsername || "Zander"}`,
    iconURL: ctx.actorAvatarUrl || undefined,
  });
  const sent = await channel.send({ embeds: [embed] });
  return { status: "succeeded", message: "Embed sent", refs: { discordMessageId: sent?.id } };
}
