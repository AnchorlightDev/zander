import { Command } from "@sapphire/framework";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
} from "discord.js";
import fetch from "node-fetch";
import {
  getUserPermissions,
  UserGetter,
} from "../controllers/userController.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const features = require("../features.json");

import { internalApiHeaders } from "../api/common.js";
export class BridgeCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("bridge")
        .setDescription("Manage and view bridge status.")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("status")
            .setDescription("View the current bridge executor queue.")
            .addStringOption((option) =>
              option
                .setName("status")
                .setDescription("Filter by task status.")
                .addChoices(
                  { name: "Pending", value: "pending" },
                  { name: "Processing", value: "processing" },
                  { name: "Completed", value: "completed" },
                  { name: "Failed", value: "failed" },
                  { name: "All statuses", value: "all" }
                )
            )
            .addStringOption((option) =>
              option
                .setName("slug")
                .setDescription("Filter to a specific target slug.")
            )
            .addIntegerOption((option) =>
              option
                .setName("limit")
                .setDescription("How many tasks to include per status (default 10).")
                .setMinValue(1)
                .setMaxValue(25)
            )
            .addBooleanOption((option) =>
              option
                .setName("claim")
                .setDescription(
                  "Claim pending tasks while retrieving the queue (pending status only)."
                )
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("add")
            .setDescription("Queue a command for a specific server slug.")
            .addStringOption((option) =>
              option
                .setName("command")
                .setDescription("The command for the bridge.")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("slug")
                .setDescription(
                  "The slug of the server to target (e.g. proxy, survival)."
                )
                .setRequired(true)
            )
            .addIntegerOption((option) =>
              option
                .setName("priority")
                .setDescription("Optional priority value (defaults to 0).")
            )
            .addStringOption((option) =>
              option
                .setName("metadata")
                .setDescription(
                  "Optional JSON metadata payload to attach to the task."
                )
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("routine")
            .setDescription("Trigger a saved routine of bridge commands.")
            .addStringOption((option) =>
              option
                .setName("slug")
                .setDescription("The slug of the routine to run.")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("metadata")
                .setDescription(
                  "Optional JSON metadata payload shared with every routine step."
                )
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("report")
            .setDescription("Report the status of an executor task.")
            .addIntegerOption((option) =>
              option
                .setName("taskid")
                .setDescription("The executor task ID to report on.")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("status")
                .setDescription("New status for the task.")
                .setRequired(true)
                .addChoices(
                  { name: "Pending", value: "pending" },
                  { name: "Processing", value: "processing" },
                  { name: "Completed", value: "completed" },
                  { name: "Failed", value: "failed" }
                )
            )
            .addStringOption((option) =>
              option
                .setName("result")
                .setDescription("Optional result or error message to store.")
            )
            .addStringOption((option) =>
              option
                .setName("executedby")
                .setDescription("Optional executor identifier reported by the server.")
            )
            .addStringOption((option) =>
              option
                .setName("metadata")
                .setDescription(
                  "Optional JSON metadata payload to merge with the task."
                )
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("reset")
            .setDescription("Reset an executor task back to pending.")
            .addIntegerOption((option) =>
              option
                .setName("taskid")
                .setDescription("The executor task ID to reset.")
                .setRequired(true)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("clear")
            .setDescription("Clear commands from the bridge queue.")
            .addStringOption((option) =>
              option
                .setName("status")
                .setDescription("Optional status filter when clearing tasks.")
                .addChoices(
                  { name: "Pending", value: "pending" },
                  { name: "Processing", value: "processing" },
                  { name: "Completed", value: "completed" },
                  { name: "Failed", value: "failed" }
                )
            )
            .addStringOption((option) =>
              option
                .setName("slug")
                .setDescription("Optional target slug filter when clearing.")
            )
            .addStringOption((option) =>
              option
                .setName("routine")
                .setDescription(
                  "Optional routine slug filter to remove queued routine tasks."
                )
            )
        )
    );
  }

  async chatInputRun(interaction) {
    if (!features.bridge) {
      const errorEmbed = new EmbedBuilder()
        .setTitle("Feature Disabled")
        .setDescription(
          `This feature has been disabled by your System Administrator.`
        )
        .setColor(Colors.Red);

      return interaction.reply({
        embeds: [errorEmbed],
        ephemeral: true,
      });
    }

    // Resolve the user to a User ID in the database
    const userData = new UserGetter();
    const userGetData = await userData.byDiscordId(interaction.user.id);

    if (!userGetData) {
      const errorEmbed = new EmbedBuilder()
        .setTitle("No Linked Account")
        .setDescription(
          "We couldn't find a linked site account for you. Please link your account before using bridge commands."
        )
        .setColor(Colors.Red);

      return interaction.reply({
        embeds: [errorEmbed],
        ephemeral: true,
      });
    }

    const userPermissions = await getUserPermissions(userGetData);
    const hasPermission = userPermissions.includes("zander.web.bridge");

    if (!hasPermission) {
      const errorEmbed = new EmbedBuilder()
        .setTitle("No Permission")
        .setDescription(`You do not have access to use this command.`)
        .setColor(Colors.Red);

      return interaction.reply({
        embeds: [errorEmbed],
        ephemeral: true,
      });
    }

    const subcommand = interaction.options.getSubcommand();

    const metadataFromOption = (optionName) => {
      const raw = interaction.options.getString(optionName);
      if (!raw) return null;
      const trimmed = raw.trim();
      if (!trimmed) return null;

      try {
        const parsed = JSON.parse(trimmed);
        if (parsed === null || typeof parsed !== "object") {
          throw new Error();
        }
        return parsed;
      } catch (error) {
        throw new Error(
          `We couldn't parse the ${optionName} value. Please provide valid JSON (e.g. {"requestedBy":"Discord"}).`
        );
      }
    };

    const sanitizeCommand = (value) =>
      typeof value === "string" ? value.trim().replace(/^\/+/, "") : "";

    const postBridge = async (path, payload) =>
      fetch(`${process.env.siteAddress}${path}`, {
        method: "POST",
        headers: internalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });

    if (subcommand === "status") {
      const statusFilter = interaction.options.getString("status") || "pending";
      const slugFilter = interaction.options.getString("slug");
      const limit = interaction.options.getInteger("limit") || 10;
      const claim = interaction.options.getBoolean("claim") || false;

      await interaction.deferReply({ ephemeral: true });

      const statusMap = {
        pending: { label: "Pending", color: Colors.Blurple },
        processing: { label: "Processing", color: Colors.Orange },
        completed: { label: "Completed", color: Colors.Green },
        failed: { label: "Failed", color: Colors.Red },
      };

      const statusesToFetch =
        statusFilter === "all"
          ? ["pending", "processing", "completed", "failed"]
          : [statusFilter];

      try {
        const fetchResults = await Promise.all(
          statusesToFetch.map(async (status) => {
            const url = new URL(
              `${process.env.siteAddress}/api/bridge/processor/get`
            );
            url.searchParams.set("status", status);
            url.searchParams.set("limit", String(limit));
            if (slugFilter) {
              url.searchParams.set("slug", slugFilter);
            }
            if (claim && status === "pending") {
              url.searchParams.set("claim", "true");
            }

            const response = await fetch(url, {
              headers: internalApiHeaders(),
            });
            const data = await response.json();
            if (!data.success) {
              throw new Error(data.message || "Unknown API error");
            }

            return { status, tasks: data.data || [], meta: data.meta };
          })
        );

        const totalTasks = fetchResults.reduce(
          (acc, item) => acc + (item.tasks?.length || 0),
          0
        );

        if (totalTasks === 0) {
          const emptyEmbed = new EmbedBuilder()
            .setTitle("Bridge Status")
            .setDescription("No executor tasks matched your filters.")
            .setColor(Colors.Blurple);

          if (slugFilter) {
            emptyEmbed.addFields({
              name: "Filters",
              value: `Slug: **${slugFilter}**\nStatus: **${statusFilter}**`,
            });
          }

          return interaction.editReply({ embeds: [emptyEmbed] });
        }

        const statusEmbed = new EmbedBuilder()
          .setTitle("Bridge Status")
          .setColor(
            fetchResults.length === 1
              ? statusMap[fetchResults[0].status]?.color ?? Colors.Blurple
              : Colors.Blurple
          );

        const footerText =
          claim && statusesToFetch.includes("pending")
            ? "Pending tasks were claimed."
            : null;

        if (footerText) {
          statusEmbed.setFooter({ text: footerText });
        }

        if (slugFilter) {
          statusEmbed.addFields({
            name: "Filters",
            value: `Slug: **${slugFilter}**\nStatus: **${statusFilter}**`,
          });
        }

        const summaryText = fetchResults
          .map((item) => {
            const label = statusMap[item.status]?.label || item.status;
            const count = item.meta?.count ?? item.tasks.length;
            return `${label}: **${count}**`;
          })
          .join(" | ");

        if (summaryText.length) {
          statusEmbed.setDescription(summaryText);
        }

        fetchResults.forEach((item) => {
          const { status, tasks } = item;
          const header = `${statusMap[status]?.label || status} — ${tasks.length} task${
            tasks.length === 1 ? "" : "s"
          }`;

          if (!tasks.length) {
            statusEmbed.addFields({
              name: header,
              value: "No tasks found.",
              inline: false,
            });
            return;
          }

          const lines = tasks.map((task) => {
            const parts = [
              `#${task.executorTaskId} • ${task.slug}`,
              `\`${task.command}\``,
            ];

            if (typeof task.priority === "number" && task.priority !== 0) {
              parts.push(`Priority: ${task.priority}`);
            }

            if (task.routineSlug) {
              parts.push(`Routine: ${task.routineSlug}`);
            }

            if (task.metadata && Object.keys(task.metadata).length) {
              const preview = JSON.stringify(task.metadata);
              parts.push(`Metadata: ${preview.substring(0, 150)}`);
            }

            if (task.executedBy) {
              parts.push(`Executor: ${task.executedBy}`);
            }

            if (task.createdAt) {
              const created = new Date(task.createdAt);
              if (!Number.isNaN(created.getTime())) {
                parts.push(`Queued: ${created.toLocaleString()}`);
              }
            }

            return parts.join("\n");
          });

          statusEmbed.addFields({
            name: header,
            value: lines.join("\n\n").slice(0, 1000),
            inline: false,
          });
        });

        return interaction.editReply({ embeds: [statusEmbed] });
      } catch (error) {
        const errorEmbed = new EmbedBuilder()
          .setTitle("Bridge Status Error")
          .setDescription(
            `There was an error fetching the bridge status queue. ${error.message || error}`
          )
          .setColor(Colors.Red);

        return interaction.editReply({ embeds: [errorEmbed] });
      }
    }

    if (subcommand === "add") {
      const rawCommand = interaction.options.getString("command");
      const command = sanitizeCommand(rawCommand);
      const slug = interaction.options.getString("slug");
      const priority = interaction.options.getInteger("priority") || 0;

      try {
        const metadata = metadataFromOption("metadata");

        if (!command) {
          throw new Error(
            "Command must include text after removing the leading slash."
          );
        }

        const payload = {
          command,
          slug,
          priority,
          metadata:
            metadata ?? {
              requestedBy: "Discord",
              requestedById: interaction.user.id,
            },
          actioningUser: userGetData.userId,
        };

        await interaction.deferReply({ ephemeral: true });

        const response = await postBridge(
          "/api/bridge/processor/command/add",
          payload
        );

        const apiData = await response.json();

        if (!apiData.success) {
          throw new Error(apiData.message || "The API responded with an error.");
        }

        const queuedTasks = Array.isArray(apiData.data) ? apiData.data.length : 1;

        const successEmbed = new EmbedBuilder()
          .setTitle("Bridge Command Added")
          .setDescription(
            `Queued ${queuedTasks} task${queuedTasks === 1 ? "" : "s"} for **${slug}**.`
          )
          .addFields({ name: "Command", value: `\`${command}\`` })
          .setColor(Colors.Green);

        if (metadata) {
          successEmbed.addFields({
            name: "Metadata",
            value: `\`${JSON.stringify(metadata).slice(0, 250)}\``,
          });
        }

        return interaction.editReply({ embeds: [successEmbed] });
      } catch (error) {
        const errorEmbed = new EmbedBuilder()
          .setTitle("Bridge Add Error")
          .setDescription(error.message || "There was an error adding the bridge.")
          .setColor(Colors.Red);

        if (interaction.deferred || interaction.replied) {
          return interaction.editReply({ embeds: [errorEmbed] });
        }

        return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }

    if (subcommand === "routine") {
      const routineSlug = interaction.options.getString("slug");

      try {
        const metadata = metadataFromOption("metadata");

        await interaction.deferReply({ ephemeral: true });

        const payload = {
          routineSlug,
          metadata:
            metadata ?? {
              requestedBy: "Discord",
              requestedById: interaction.user.id,
            },
          actioningUser: userGetData.userId,
        };

        const response = await postBridge(
          "/api/bridge/processor/command/add",
          payload
        );
        const apiData = await response.json();

        if (!apiData.success) {
          throw new Error(apiData.message || "The API responded with an error.");
        }

        const queuedTasks = Array.isArray(apiData.data) ? apiData.data.length : 0;

        const successEmbed = new EmbedBuilder()
          .setTitle("Routine Queued")
          .setDescription(
            `Routine **${routineSlug}** queued ${queuedTasks} task${
              queuedTasks === 1 ? "" : "s"
            }.`
          )
          .setColor(Colors.Green);

        if (metadata) {
          successEmbed.addFields({
            name: "Metadata",
            value: `\`${JSON.stringify(metadata).slice(0, 250)}\``,
          });
        }

        return interaction.editReply({ embeds: [successEmbed] });
      } catch (error) {
        const errorEmbed = new EmbedBuilder()
          .setTitle("Routine Error")
          .setDescription(
            error.message || "There was an error queuing the requested routine."
          )
          .setColor(Colors.Red);

        if (interaction.deferred || interaction.replied) {
          return interaction.editReply({ embeds: [errorEmbed] });
        }

        return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }

    if (subcommand === "report") {
      const taskId = interaction.options.getInteger("taskid");
      const status = interaction.options.getString("status");
      const resultText = interaction.options.getString("result");
      const executedBy = interaction.options.getString("executedby");

      try {
        const metadata = metadataFromOption("metadata");

        await interaction.deferReply({ ephemeral: true });

        const payload = {
          status,
          result: resultText || null,
          executedBy: executedBy || `discord:${interaction.user.id}`,
          metadata: metadata ?? null,
          actioningUser: userGetData.userId,
        };

        const response = await postBridge(
          `/api/bridge/processor/task/${taskId}/report`,
          payload
        );
        const apiData = await response.json();

        if (!apiData.success) {
          throw new Error(apiData.message || "Failed to submit the report.");
        }

        const successEmbed = new EmbedBuilder()
          .setTitle("Task Reported")
          .setDescription(`Task #${taskId} marked as **${status}**.`)
          .setColor(Colors.Green);

        if (resultText) {
          successEmbed.addFields({ name: "Result", value: resultText });
        }

        if (metadata) {
          successEmbed.addFields({
            name: "Metadata",
            value: `\`${JSON.stringify(metadata).slice(0, 250)}\``,
          });
        }

        return interaction.editReply({ embeds: [successEmbed] });
      } catch (error) {
        const errorEmbed = new EmbedBuilder()
          .setTitle("Report Error")
          .setDescription(error.message || "There was an error reporting the task.")
          .setColor(Colors.Red);

        if (interaction.deferred || interaction.replied) {
          return interaction.editReply({ embeds: [errorEmbed] });
        }

        return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }

    if (subcommand === "reset") {
      const taskId = interaction.options.getInteger("taskid");

      try {
        await interaction.deferReply({ ephemeral: true });

        const payload = {
          actioningUser: userGetData.userId,
        };

        const response = await postBridge(
          `/api/bridge/processor/task/${taskId}/reset`,
          payload
        );
        const apiData = await response.json();

        if (!apiData.success) {
          throw new Error(apiData.message || "Failed to reset the task.");
        }

        const successEmbed = new EmbedBuilder()
          .setTitle("Task Reset")
          .setDescription(`Task #${taskId} has been returned to pending.`)
          .setColor(Colors.Green);

        return interaction.editReply({ embeds: [successEmbed] });
      } catch (error) {
        const errorEmbed = new EmbedBuilder()
          .setTitle("Reset Error")
          .setDescription(error.message || "There was an error resetting the task.")
          .setColor(Colors.Red);

        if (interaction.deferred || interaction.replied) {
          return interaction.editReply({ embeds: [errorEmbed] });
        }

        return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }

    if (subcommand === "clear") {
      const statusFilter = interaction.options.getString("status");
      const slugFilter = interaction.options.getString("slug");
      const routineFilter = interaction.options.getString("routine");

      const summary = [
        statusFilter ? `Status: **${statusFilter}**` : null,
        slugFilter ? `Slug: **${slugFilter}**` : null,
        routineFilter ? `Routine: **${routineFilter}**` : null,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        const confirmationEmbed = new EmbedBuilder()
          .setTitle("Clear bridge queue?")
          .setDescription(
            summary.length
              ? `This will remove all matching tasks.\n\n${summary}\n\nThis action cannot be undone.`
              : "This will remove every task from the executor queue. This action cannot be undone."
          )
          .setColor(Colors.Orange);

        const yesButton = new ButtonBuilder()
          .setCustomId("clear_bridge_yes")
          .setLabel("Confirm clear")
          .setStyle(ButtonStyle.Danger);

        const noButton = new ButtonBuilder()
          .setCustomId("clear_bridge_no")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary);

        const actionRow = new ActionRowBuilder().addComponents(
          yesButton,
          noButton
        );

        await interaction.reply({
          embeds: [confirmationEmbed],
          components: [actionRow],
          ephemeral: true,
        });

        const filter = (i) =>
          i.user.id === interaction.user.id &&
          ["clear_bridge_yes", "clear_bridge_no"].includes(i.customId);

        const collector = interaction.channel?.createMessageComponentCollector({
          filter,
          time: 15000,
        });

        if (!collector) {
          return interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("Bridge Clear Error")
                .setDescription("Unable to start confirmation collector in this channel.")
                .setColor(Colors.Red),
            ],
            components: [],
          });
        }

        collector.on("collect", async (i) => {
          if (i.customId === "clear_bridge_no") {
            const canceledEmbed = new EmbedBuilder()
              .setTitle("Action Canceled")
              .setDescription("The bridge clear action has been canceled.")
              .setColor(Colors.Grey);

            collector.stop("canceled");
            return i.update({ embeds: [canceledEmbed], components: [] });
          }

          try {
            const payload = {
              actioningUser: userGetData.userId,
            };

            if (statusFilter) payload.status = statusFilter;
            if (slugFilter) payload.slug = slugFilter;
            if (routineFilter) payload.routineSlug = routineFilter;

            const response = await postBridge(
              "/api/bridge/processor/clear",
              payload
            );
            const apiData = await response.json();

            if (!apiData.success) {
              throw new Error(apiData.message || "Failed to clear the queue.");
            }

            const successEmbed = new EmbedBuilder()
              .setTitle("Bridge Cleared")
              .setDescription(apiData.message || "The executor queue has been cleared.")
              .setColor(Colors.Green);

            collector.stop("completed");
            return i.update({ embeds: [successEmbed], components: [] });
          } catch (error) {
            const errorEmbed = new EmbedBuilder()
              .setTitle("Bridge Clear Error")
              .setDescription(error.message || "There was an error clearing the bridge.")
              .setColor(Colors.Red);

            collector.stop("failed");
            return i.update({ embeds: [errorEmbed], components: [] });
          }
        });

        collector.on("end", (collected, reason) => {
          if (reason === "time") {
            interaction.editReply({
              content: "No response received. Action has been canceled.",
              components: [],
            });
          }
        });
      } catch (error) {
        const errorEmbed = new EmbedBuilder()
          .setTitle("Bridge Clear Error")
          .setDescription(
            error.message || "There was an error initiating the bridge clear process."
          )
          .setColor(Colors.Red);

        return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
      }
    }
  }
}
