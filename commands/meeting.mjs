import { Command } from "@sapphire/framework";
import { Colors, EmbedBuilder } from "discord.js";
import { createRequire } from "module";

import { hasPermission } from "../lib/discord/permissions.mjs";
import { getUserPermissions, UserGetter } from "../controllers/userController.js";
import {
  currentOffsetMs,
  getRecorder,
  pauseRecording,
  resumeRecording,
  startRecording,
  stopRecording,
} from "../lib/discord/meetingRecorder.mjs";
import {
  SESSION_STATUS,
  advanceAgenda,
  createNote,
  getSessions,
  getViewerContext,
} from "../services/meetingSessionService.js";
import { ATTENDEE_ROLE, REVEAL_MODE, VISIBILITY } from "../lib/meetings/visibility.mjs";

const require = createRequire(import.meta.url);
const features = require("../features.json");

/**
 * Split from `.manage` so the person who chairs and records a meeting does not
 * need full meetings administration — a team lead can run their own meeting
 * without also being able to edit everyone else's.
 */
const RECORD_NODE = "zander.web.meetings.record";
const MANAGE_NODE = "zander.web.meetings.manage";

/** "1:23:45" / "4:07" — the form people read back to each other in a meeting. */
function formatOffset(ms) {
  if (ms == null) return "—";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function errorEmbed(title, description) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(Colors.Red);
}

/**
 * Discord slash commands for running a meeting.
 *
 * Every subcommand calls the same service functions the dashboard does — which
 * is the point of the two-runtimes-one-codebase architecture, and what lets the
 * chair stamp the agenda and take minutes from inside the call while they are
 * still talking, instead of alt-tabbing to a browser mid-sentence.
 */
export class MeetingCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("meeting")
        .setDescription("Run a recorded meeting: start, advance the agenda, take notes, stop.")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("start")
            .setDescription("Announce, join your voice channel and start recording.")
            .addIntegerOption((option) =>
              option
                .setName("session")
                .setDescription("Meeting session id. Omit to use the next scheduled one.")
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("next")
            .setDescription("Close the current agenda item and stamp the next one.")
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("note")
            .setDescription("Record a note, decision or action against the current agenda item.")
            .addStringOption((option) =>
              option.setName("text").setDescription("What to record.").setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("kind")
                .setDescription("What sort of note this is (default: note).")
                .addChoices(
                  { name: "Note", value: "note" },
                  { name: "Decision", value: "decision" },
                  { name: "Action", value: "action" }
                )
            )
            .addStringOption((option) =>
              option
                .setName("visibility")
                .setDescription("Who may read it (default: attendees).")
                .addChoices(
                  { name: "Public — anyone who can see the meeting", value: "public" },
                  { name: "Attendees — on the roster", value: "attendees" },
                  { name: "Speakers — chairs and speakers only", value: "speakers" },
                  { name: "Private — just me", value: "private" }
                )
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("pause")
            .setDescription("Pause or resume capture without ending the meeting.")
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("stop")
            .setDescription("Stop recording, mix down and publish the session.")
        )
    );
  }

  async chatInputRun(interaction) {
    if (!features.meetings) {
      return interaction.reply({
        embeds: [errorEmbed("Meetings Disabled", "The meetings module is turned off.")],
        ephemeral: true,
      });
    }

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (error) {
      console.error("[meeting] failed to defer reply:", error);
      return;
    }

    // Everything here is keyed on the caller's *website* account: permissions,
    // note authorship and attendance all live there, not on the Discord user.
    const linkedAccount = await new UserGetter().byDiscordId(interaction.user.id);
    if (!linkedAccount) {
      return interaction.editReply({
        embeds: [
          errorEmbed(
            "No Linked Account",
            "Link your website account before running meeting commands — notes and attendance are recorded against it."
          ),
        ],
      });
    }

    const permissions = await getUserPermissions(linkedAccount);
    const canRecord =
      hasPermission(permissions, RECORD_NODE) || hasPermission(permissions, MANAGE_NODE);

    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case "start":
          return await this.runStart(interaction, linkedAccount, canRecord);
        case "next":
          return await this.runNext(interaction, linkedAccount, canRecord);
        case "note":
          return await this.runNote(interaction, linkedAccount, permissions);
        case "pause":
          return await this.runPause(interaction, canRecord);
        case "stop":
          return await this.runStop(interaction, canRecord);
        default:
          return interaction.editReply({ content: "Unknown subcommand." });
      }
    } catch (error) {
      console.error(`[meeting] ${subcommand} failed:`, error);
      return interaction.editReply({
        embeds: [errorEmbed("Meeting Command Failed", error.message || "Something went wrong.")],
      });
    }
  }

  denyRecord(interaction) {
    return interaction.editReply({
      embeds: [
        errorEmbed(
          "No Permission",
          `You need \`${RECORD_NODE}\` to record meetings.`
        ),
      ],
    });
  }

  /**
   * The session this guild is currently running.
   *
   * There is exactly one live recorder per session, so "the meeting in
   * progress" is unambiguous without the caller naming an id mid-meeting.
   */
  async resolveLiveSession() {
    const { sessions } = await getSessions({ status: SESSION_STATUS.LIVE, limit: 10 });
    const running = sessions.filter((session) => getRecorder(session.sessionId));

    // Fall back to the live session even with no recorder attached: the agenda
    // can still be stamped and minutes still taken during an unrecorded meeting.
    const candidates = running.length > 0 ? running : sessions;

    if (candidates.length === 0) throw new Error("No meeting is currently running.");
    if (candidates.length > 1) {
      throw new Error(
        `More than one meeting is live (${candidates
          .map((session) => `#${session.sessionId}`)
          .join(", ")}). Stop the one you are not in.`
      );
    }

    return candidates[0];
  }

  async runStart(interaction, actor, canRecord) {
    if (!canRecord) return this.denyRecord(interaction);

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.editReply({
        embeds: [
          errorEmbed(
            "Join A Voice Channel",
            "Join the voice or stage channel you want recorded, then run this again."
          ),
        ],
      });
    }

    const explicitId = interaction.options.getInteger("session");

    let target;
    if (explicitId) {
      const { sessions } = await getSessions({ limit: 200 });
      target = sessions.find((session) => session.sessionId === explicitId);
      if (!target) throw new Error(`No meeting session with id ${explicitId}.`);
    } else {
      // The next one due.  Nothing about any particular meeting is assumed —
      // this is simply the soonest draft session that exists.
      const { sessions } = await getSessions({ status: SESSION_STATUS.DRAFT, limit: 50 });
      const upcoming = sessions
        .filter((session) => session.event?.startAt)
        .sort((a, b) => new Date(a.event.startAt) - new Date(b.event.startAt));

      target = upcoming[0] || sessions[0];
      if (!target) {
        throw new Error("There is no meeting session ready to start. Create one on the dashboard first.");
      }
    }

    const { session, startOffsetMs, resumed } = await startRecording({
      client: interaction.client,
      sessionId: target.sessionId,
      eventId: target.eventId,
      voiceChannel,
      actorId: actor.userId,
    });

    const embed = new EmbedBuilder()
      .setTitle(resumed ? "🔴 Recording resumed" : "🔴 Recording started")
      .setDescription(
        [
          `**${target.event?.title || `Session #${session.sessionId}`}**`,
          `Channel: ${voiceChannel.name}`,
          resumed
            ? `This is a second recording, filed at ${formatOffset(startOffsetMs)} on the meeting timeline.`
            : "The room has been told. Use `/meeting next` to stamp agenda items as you go.",
        ].join("\n")
      )
      .setColor(Colors.Red);

    return interaction.editReply({ embeds: [embed] });
  }

  async runNext(interaction, actor, canRecord) {
    if (!canRecord) return this.denyRecord(interaction);

    const session = await this.resolveLiveSession();
    const result = await advanceAgenda({ sessionId: session.sessionId, actorId: actor.userId });

    const lines = [`At **${formatOffset(result.atOffsetMs)}**`];
    if (result.closed) lines.push(`✅ Closed: ${result.closed.title}`);
    if (result.started) lines.push(`▶️ Now: **${result.started.title}**`);
    if (!result.started) lines.push("That was the last item on the agenda.");

    return interaction.editReply({
      embeds: [
        new EmbedBuilder().setTitle("Agenda advanced").setDescription(lines.join("\n")).setColor(Colors.Blue),
      ],
    });
  }

  /**
   * Take a note against whichever agenda item is currently open.
   *
   * Open to chairs and speakers as well as to holders of the record node: the
   * person minuting a meeting is often not the person recording it.
   */
  async runNote(interaction, actor, permissions) {
    const session = await this.resolveLiveSession();

    const viewer = await getViewerContext(session.sessionId, {
      userId: actor.userId,
      isManager: hasPermission(permissions, MANAGE_NODE),
    });

    const canRecord =
      hasPermission(permissions, RECORD_NODE) || hasPermission(permissions, MANAGE_NODE);

    if (!canRecord && viewer.role !== ATTENDEE_ROLE.CHAIR && viewer.role !== ATTENDEE_ROLE.SPEAKER) {
      return interaction.editReply({
        embeds: [
          errorEmbed(
            "No Permission",
            "Only chairs, speakers and meeting recorders can take minutes."
          ),
        ],
      });
    }

    // Attach to the item that is open right now, so the note lands in the right
    // chapter without anyone naming it.
    const openItem = await findOpenAgendaItem(session.sessionId);

    const note = await createNote(
      session.sessionId,
      {
        body: interaction.options.getString("text"),
        kind: interaction.options.getString("kind") || "note",
        visibility: interaction.options.getString("visibility") || VISIBILITY.ATTENDEES,
        agendaItemId: openItem?.itemId ?? null,
        // Typed live, during the item it belongs to — there is nothing to hold
        // it back for, and a reveal delay on a note taken in the room would
        // hide it from the people who just watched it being written.
        revealMode: REVEAL_MODE.IMMEDIATE,
      },
      actor.userId
    );

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${note.kind === "decision" ? "Decision" : note.kind === "action" ? "Action" : "Note"} recorded`)
          .setDescription(note.body)
          .addFields(
            { name: "Agenda item", value: openItem?.title || "General", inline: true },
            { name: "Visible to", value: note.visibility, inline: true },
            { name: "At", value: formatOffset(currentOffsetMs(session.sessionId)), inline: true }
          )
          .setColor(Colors.Green),
      ],
    });
  }

  async runPause(interaction, canRecord) {
    if (!canRecord) return this.denyRecord(interaction);

    const session = await this.resolveLiveSession();
    const recorder = getRecorder(session.sessionId);
    if (!recorder) throw new Error("This meeting is not being recorded.");

    // Toggle: in a meeting, "pause" is what people say for both directions.
    const paused = !recorder.paused;
    if (paused) pauseRecording(session.sessionId);
    else resumeRecording(session.sessionId);

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(paused ? "⏸️ Recording paused" : "▶️ Recording resumed")
          .setDescription(
            paused
              ? "Nothing is being captured. The meeting clock keeps running, so the gap appears as silence of the right length."
              : "Capture has resumed."
          )
          .setColor(paused ? Colors.Orange : Colors.Green),
      ],
    });
  }

  async runStop(interaction, canRecord) {
    if (!canRecord) return this.denyRecord(interaction);

    const session = await this.resolveLiveSession();

    await interaction.editReply({ content: "Stopping and mixing down — this can take a minute…" });

    const { recording, durationMs } = await stopRecording({ sessionId: session.sessionId });

    const embed = new EmbedBuilder()
      .setTitle(recording ? "⏹️ Meeting recorded" : "⏹️ Meeting stopped")
      .setDescription(
        recording
          ? `**${formatOffset(durationMs)}** captured. The session is published — the recording, agenda and minutes are on the meeting page.`
          : "Nothing was captured, so the session has been left unpublished. The scratch files are on the host if anything can be salvaged."
      )
      .setColor(recording ? Colors.Green : Colors.Orange);

    return interaction.editReply({ content: "", embeds: [embed] });
  }
}

/** The agenda item the chair is currently on, if any. */
async function findOpenAgendaItem(sessionId) {
  const { prisma } = await import("../controllers/databaseController.js");
  return prisma.meetingAgendaItems.findFirst({
    where: { sessionId: parseInt(sessionId), startOffsetMs: { not: null }, endOffsetMs: null },
    orderBy: { orderIndex: "desc" },
  });
}
