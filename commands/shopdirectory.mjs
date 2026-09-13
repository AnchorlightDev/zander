import { Command } from "@sapphire/framework";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder } from "discord.js";
import { searchShops } from "../services/shopService.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const features = require("../features.json");
const config = require("../config.json");

export class ShopDirectoryCommand extends Command {
  constructor(context, options) {
    super(context, { ...options });
  }

  registerApplicationCommands(registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName("shopdirectory")
        .setDescription("List and browse shop items by material")
        .addStringOption((option) =>
          option
            .setName("material")
            .setDescription("The material to filter shop items by.")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("type")
            .setDescription("The type of transaction to filter by.")
            .setRequired(false)
            .addChoices(
              { name: "Buying", value: "buying" },
              { name: "Selling", value: "selling" }
            )
        )
    );
  }

  async chatInputRun(interaction) {
    try {
      await interaction.deferReply();
    } catch {
      return;
    }

    if (!features.shopdirectory) {
      const errorEmbed = new EmbedBuilder()
        .setTitle("Feature Disabled")
        .setDescription(
          `This feature has been disabled by your System Administrator.`
        )
        .setColor(Colors.Red);

      return interaction.editReply({
        embeds: [errorEmbed],
      });
    }

    const allowedChannelId = config.discord.botChannelId;
    if (allowedChannelId && interaction.channelId !== allowedChannelId) {
      const channelEmbed = new EmbedBuilder()
        .setTitle("Wrong Channel")
        .setDescription(
          `This command can only be used in <#${allowedChannelId}>.`
        )
        .setColor(Colors.Red);

      return interaction.editReply({
        embeds: [channelEmbed],
      });
    }

    const material = interaction.options.getString("material") || "";
    const type = interaction.options.getString("type");

    try {
      // Fetch shop data directly (no HTTP self-call)
      const apiData = await searchShops(material, 1, { includeProfilePictures: false });

      if (!apiData.success || !apiData.data.length) {
        const noItemsEmbed = new EmbedBuilder()
          .setTitle("No Shop Items Found")
          .setDescription(
            `No shop items were found${
              material ? ` for material: \`${material}\`` : ""
            }.`
          )
          .setColor(Colors.Orange);

        return interaction.editReply({
          embeds: [noItemsEmbed],
        });
      }

      // Filter out shops with no stock (stock is 0)
      const originalShopCount = apiData.data.length;
      let inStockShops = apiData.data.filter(shop => shop.stock !== 0);
      const outOfStockCount = originalShopCount - inStockShops.length;
      
      if (type) {
        if (type === "buying") {
          inStockShops = inStockShops.filter(shop => shop.stock === -1);
        } else if (type === "selling") {
          inStockShops = inStockShops.filter(shop => shop.stock > 0);
        }
      }

      if (!inStockShops.length) {
        const noItemsEmbed = new EmbedBuilder()
          .setTitle("No Shop Items Found")
          .setDescription(
            `No shop items were found${
              material ? ` for material: \`${material}\`` : ""
            }.`
          )
          .setColor(Colors.Orange);

        if (outOfStockCount > 0) {
          noItemsEmbed.setFooter({ text: `${outOfStockCount} shop(s) not shown (out of stock).` });
        }

        return interaction.editReply({
          embeds: [noItemsEmbed],
        });
      }

      // Find the most frequent item for the thumbnail
      const itemCounts = new Map();
      inStockShops.forEach(shop => {
        const itemName = shop.itemData.name;
        if (itemName) {
          itemCounts.set(itemName, (itemCounts.get(itemName) || 0) + 1);
        }
      });

      let mostFrequentItemName = "";
      let maxCount = 0;
      for (const [itemName, count] of itemCounts.entries()) {
        if (count > maxCount) {
          maxCount = count;
          mostFrequentItemName = itemName;
        }
      }

      const mostFrequentItem = inStockShops.find(shop => shop.itemData.name === mostFrequentItemName);
      const thumbnailUrl = mostFrequentItem?.itemData?.image;

      // Create pages of shops
      const shopPages = [];
      const shopsPerPage = 8;
      for (let i = 0; i < inStockShops.length; i += shopsPerPage) {
        shopPages.push(inStockShops.slice(i, i + shopsPerPage));
      }

      let currentPageIndex = 0;

      const createEmbed = (pageIndex) => {
        const page = shopPages[pageIndex];
        const embed = new EmbedBuilder()
          .setTitle("🛍️ Shop Directory")
          .setDescription(
            `🔍 Here are the shop items${
              material ? ` for material: \`${material}\`` : ""
            }.`
          )
          .setColor(Colors.Blue);

        if (thumbnailUrl) {
          embed.setThumbnail(thumbnailUrl);
        }

        page.forEach((shop) => {
          const transactionType = shop.stock === -1 ? "💰 Buying" : "📦 Selling";
          const stockInfo = shop.stock !== -1 ? `**Stock:** ${shop.stock}\n` : "";
          const contentsInfo = shop.shulkerContents ? `**Contents:** ${shop.shulkerContents}\n` : "";

          embed.addFields([
            {
              name: `Item: ${shop.itemData.displayName}`,
              value: `**Seller:** \`${shop.userData.username}\`\n**Amount:** ${shop.amount}\n**Price:** $${shop.price}\n${stockInfo}**Type:** ${transactionType}\n**Location:** ${shop.x}, ${shop.y}, ${shop.z}${contentsInfo ? `\n${contentsInfo.trim()}` : ""}`,
            },
          ]);
        });

        let footerText = `Page ${pageIndex + 1} of ${shopPages.length}`;
        if (outOfStockCount > 0) {
          footerText += ` | ${outOfStockCount} shop(s) not shown (out of stock).`;
        }
        embed.setFooter({ text: footerText });

        return embed;
      };

      // Only show buttons and create a collector if there's more than one page
      if (shopPages.length > 1) {
        const getRow = (pageIndex) => {
          return new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId('prev_page')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(pageIndex === 0),
              new ButtonBuilder()
                .setCustomId('next_page')
                .setLabel('Next')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(pageIndex === shopPages.length - 1)
            );
        };

        const reply = await interaction.editReply({
          embeds: [createEmbed(currentPageIndex)],
          components: [getRow(currentPageIndex)]
        });

        const collector = reply.createMessageComponentCollector({
          filter: (i) => i.user.id === interaction.user.id,
          time: 60000 // 1 minute
        });

        collector.on('collect', async (i) => {
          if (i.customId === 'prev_page') {
            currentPageIndex--;
          } else if (i.customId === 'next_page') {
            currentPageIndex++;
          }

          await i.update({
            embeds: [createEmbed(currentPageIndex)],
            components: [getRow(currentPageIndex)]
          });
        });

        collector.on('end', async () => {
          const disabledRow = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId('prev_page')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true),
              new ButtonBuilder()
                .setCustomId('next_page')
                .setLabel('Next')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true)
            );
          await reply.edit({ components: [disabledRow] }).catch(() => {});
        });
      } else {
        // If there's only one page, just send the embed without any components
        await interaction.editReply({
          embeds: [createEmbed(currentPageIndex)]
        });
      }
    } catch (error) {
      console.error("Error fetching shop items:", error);

      const errorEmbed = new EmbedBuilder()
        .setTitle("Error")
        .setDescription(
          "There was an error fetching the shop items. Please try again later."
        )
        .setColor(Colors.Red);

      interaction.editReply({
        embeds: [errorEmbed],
      });
    }
  }
}
