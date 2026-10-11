/**
 * services/contactTicketService.js
 *
 * The contact form opens a support ticket (category "Contact form").
 *
 *   Signed in  -> an ordinary ticket on their account, at /support/ticket/:id.
 *   Guest      -> a ticket tied to the email they gave (no owner). They get a
 *                 confirmation email with a private link (lib/guestTickets.mjs),
 *                 every public staff reply is emailed to them, and they answer
 *                 on that private page.
 *
 * Staff work the ticket as usual -- on the website or in its Discord channel.
 */

import { createRequire } from "module";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { client } from "../controllers/discordController.js";
import {
  CONTACT_CATEGORY_NAME,
  createSupportTicket,
  createSupportTicketMessage,
  emailGuestTicketUpdate,
  ensureContactCategory,
  getCategoryDiscordParentId,
  getCategoryPermissions,
  getTicketById,
  syncParticipantsForMessage,
} from "../controllers/supportTicketController.js";
import { isValidGuestTicketToken } from "../lib/guestTickets.mjs";

const require = createRequire(import.meta.url);
const config = require("../lib/config/config.cjs");

const siteUrl = () => String(config.siteConfiguration?.siteUrl || process.env.siteAddress || "").replace(/\/+$/, "");

async function postOpener(channel, { ticketId, subject, message, from }) {
  const embed = new EmbedBuilder()
    .setTitle(`Ticket #${ticketId}: ${subject}`.slice(0, 256))
    .setDescription(message.slice(0, 4000))
    .addFields({ name: "From", value: from.slice(0, 1024) }, { name: "Category", value: CONTACT_CATEGORY_NAME })
    .setTimestamp(new Date())
    .setColor(0x2b6cb0);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("View Ticket Online").setURL(`${siteUrl()}/support/ticket/${ticketId}`),
    new ButtonBuilder().setCustomId("support_ticket_close").setLabel("Close Ticket").setStyle(ButtonStyle.Danger)
  );

  try {
    const sent = await channel.send({ content: "New message from the contact form.", embeds: [embed], components: [buttons] });
    await sent.pin().catch(() => {});
  } catch (error) {
    console.error("[contact] Could not post the ticket opener to Discord:", error.message);
  }
}

/**
 * Open a ticket from the contact form.
 *
 * @param {{ name, email, subject, message }} form   Already validated.
 * @param {object|null} user  The signed-in session user, if any.
 * @returns {Promise<{ ticketId: number, guest: boolean }>}
 */
export async function openContactTicket(form, user = null) {
  const categoryId = await ensureContactCategory();
  const [staffRoleIds, parentCategoryId] = await Promise.all([
    getCategoryPermissions(categoryId).catch(() => []),
    getCategoryDiscordParentId(categoryId).catch(() => null),
  ]);

  const signedIn = Boolean(user?.userId);
  const discordUserId = signedIn ? user.discordId || user.discordID || null : null;

  const { ticketId, channel } = await createSupportTicket(client, signedIn ? user.userId : null, categoryId, form.subject, {
    discordUserId,
    staffRoleIds,
    parentCategoryId,
    guest: signedIn ? null : { email: form.email, name: form.name },
  });

  await createSupportTicketMessage(client, ticketId, signedIn ? user.userId : null, form.message, "web", { skipDiscordPost: true });

  if (signedIn) {
    await syncParticipantsForMessage(client, ticketId, {
      userId: user.userId,
      rankSlugs: user.ranks?.map((rank) => rank.rankSlug) || [],
    }).catch((error) => console.error("[contact] Could not add the sender as a participant:", error.message));
  }

  if (channel) {
    const from = signedIn ? `${user.username}` : `${form.name} <${form.email}> — guest, replies go by email`;
    await postOpener(channel, { ticketId, subject: form.subject, message: form.message, from });
  }

  if (!signedIn) {
    const ticket = await getTicketById(ticketId);
    await emailGuestTicketUpdate(ticket, { kind: "received" }).catch((error) =>
      console.error(`[contact] Could not send the confirmation email for ticket #${ticketId}:`, error.message)
    );
  }

  console.log(`[contact] Ticket #${ticketId} opened from the contact form (${signedIn ? `user ${user.username}` : "guest"}).`);
  return { ticketId, guest: !signedIn };
}

/** The guest ticket a private link opens, or null when the link is wrong. */
export async function getGuestTicket(ticketId, token) {
  const ticket = await getTicketById(Number(ticketId));
  if (!ticket?.guestEmail || !isValidGuestTicketToken(ticket.ticketId, ticket.guestEmail, token)) return null;
  return ticket;
}

/**
 * A guest's reply from their private page. Posted to the ticket's Discord
 * channel and to staff notifications like any other reply.
 */
export async function replyAsGuest(ticket, message) {
  if (ticket.status === "closed") return { ok: false, error: "This conversation has been closed. Please send a new message from the contact page." };
  await createSupportTicketMessage(client, ticket.ticketId, null, message, "web");
  return { ok: true };
}
