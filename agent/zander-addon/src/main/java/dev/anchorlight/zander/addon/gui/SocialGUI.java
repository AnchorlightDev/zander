package dev.anchorlight.zander.addon.gui;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.NamespacedKey;
import dev.anchorlight.zander.addon.ZanderAddonMain;
import dev.anchorlight.zander.addon.model.SocialConfig;

import java.util.List;
import java.util.Map;

public class SocialGUI implements Listener {
    private final ZanderAddonMain plugin;
    private final Component inventoryTitle = Component.text("Social Media", NamedTextColor.DARK_PURPLE);
    private final NamespacedKey platformKey;

    public SocialGUI(ZanderAddonMain plugin) {
        this.plugin = plugin;
        this.platformKey = new NamespacedKey(plugin, "social_platform");
    }

    public void open(Player player) {
        plugin.getPolicyService().fetchSocialLinks().thenAccept(config -> {
            Bukkit.getScheduler().runTask(plugin, () -> {
                Map<String, String> platforms = config.getPlatforms();
                int size = 9 * ((platforms.size() / 9) + 1);
                Inventory gui = Bukkit.createInventory(null, size, inventoryTitle);

                int slot = 0;
                for (Map.Entry<String, String> entry : platforms.entrySet()) {
                    String platform = entry.getKey();
                    String url = entry.getValue();

                    ItemStack item = createSocialItem(platform, url);
                    gui.setItem(slot++, item);
                }

                player.openInventory(gui);
            });
        }).exceptionally(ex -> {
            player.sendMessage(Component.text("Failed to fetch social media links.", NamedTextColor.RED));
            return null;
        });
    }

    private ItemStack createSocialItem(String platform, String url) {
        Material material = Material.PAPER;
        // Basic mapping of platforms to materials for better visual
        switch (platform.toLowerCase()) {
            case "discord": material = Material.BLUE_WOOL; break;
            case "facebook": material = Material.LIGHT_BLUE_WOOL; break;
            case "twitter": material = Material.CYAN_WOOL; break;
            case "instagram": material = Material.MAGENTA_WOOL; break;
            case "twitch": material = Material.PURPLE_WOOL; break;
            case "youtube": material = Material.RED_WOOL; break;
            case "tiktok": material = Material.BLACK_WOOL; break;
        }

        ItemStack item = new ItemStack(material);
        ItemMeta meta = item.getItemMeta();
        String capitalized = platform.substring(0, 1).toUpperCase() + platform.substring(1);
        meta.displayName(Component.text(capitalized, NamedTextColor.GOLD).decorate(TextDecoration.BOLD));
        meta.lore(List.of(
                Component.text("Click to get the link to our " + capitalized, NamedTextColor.GRAY),
                Component.text(url, NamedTextColor.DARK_GRAY).decorate(TextDecoration.ITALIC)
        ));
        meta.getPersistentDataContainer().set(platformKey, PersistentDataType.STRING, platform);
        item.setItemMeta(meta);
        return item;
    }

    @EventHandler
    public void onInventoryClick(InventoryClickEvent event) {
        if (!event.getView().title().equals(inventoryTitle)) {
            return;
        }

        event.setCancelled(true);
        if (!(event.getWhoClicked() instanceof Player player)) {
            return;
        }

        ItemStack clickedItem = event.getCurrentItem();
        if (clickedItem == null || clickedItem.getType() == Material.AIR) {
            return;
        }

        ItemMeta meta = clickedItem.getItemMeta();
        if (meta == null || !meta.getPersistentDataContainer().has(platformKey, PersistentDataType.STRING)) {
            return;
        }

        String platform = meta.getPersistentDataContainer().get(platformKey, PersistentDataType.STRING);
        plugin.getPolicyService().fetchSocialLinks().thenAccept(config -> {
            String url = config.getPlatforms().get(platform);
            if (url != null) {
                String capitalized = platform.substring(0, 1).toUpperCase() + platform.substring(1);
                Component message = Component.text("Click here to visit our " + capitalized + ": ", NamedTextColor.GREEN)
                        .append(Component.text(url, NamedTextColor.AQUA)
                                .decorate(TextDecoration.UNDERLINED)
                                .clickEvent(ClickEvent.openUrl(url)));
                player.sendMessage(message);
                Bukkit.getScheduler().runTask(plugin, (Runnable) player::closeInventory);
            }
        });
    }
}
