package dev.anchorlight.zander.pgm.gui;

import com.google.gson.JsonObject;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.Plugin;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.util.JsonUtil;

import java.util.List;

/**
 * Physical inventory items that open the Map Token / Map Rating menus.
 * Identified via a PersistentDataContainer tag (not display name/material,
 * so they survive renaming and can't be spoofed by a player-crafted item
 * with the same name).
 */
public final class MenuItems {

    private static final String TAG_VALUE_TOKEN = "map_token";
    private static final String TAG_VALUE_RATING = "map_rating";

    private MenuItems() {
    }

    private static NamespacedKey key(Plugin plugin) {
        return new NamespacedKey(plugin, "zander_menu_item");
    }

    public static ItemStack tokenItem(Plugin plugin) {
        return build(plugin, Material.ENDER_PEARL, "§bMap Token", TAG_VALUE_TOKEN,
                "§7Right-click to spend a Map Token", "§7and influence the next map.");
    }

    public static ItemStack ratingItem(Plugin plugin) {
        return build(plugin, Material.NETHER_STAR, "§eRate this Map", TAG_VALUE_RATING,
                "§7Right-click to rate the map", "§7you just played.");
    }

    private static ItemStack build(Plugin plugin, Material material, String name, String tagValue, String... lore) {
        ItemStack item = new ItemStack(material);
        ItemMeta meta = item.getItemMeta();
        if (meta != null) {
            meta.setDisplayName(name);
            meta.setLore(List.of(lore));
            meta.getPersistentDataContainer().set(key(plugin), PersistentDataType.STRING, tagValue);
            item.setItemMeta(meta);
        }
        return item;
    }

    private static String tagOf(Plugin plugin, ItemStack item) {
        if (item == null || !item.hasItemMeta()) {
            return null;
        }
        ItemMeta meta = item.getItemMeta();
        return meta == null ? null : meta.getPersistentDataContainer().get(key(plugin), PersistentDataType.STRING);
    }

    public static boolean isTokenItem(Plugin plugin, ItemStack item) {
        return TAG_VALUE_TOKEN.equals(tagOf(plugin, item));
    }

    public static boolean isRatingItem(Plugin plugin, ItemStack item) {
        return TAG_VALUE_RATING.equals(tagOf(plugin, item));
    }

    /** Preferred hotbar slot for menu items — only used if that slot is actually empty. */
    private static final int PREFERRED_HOTBAR_SLOT = 8;

    /**
     * Gives the item if the player doesn't already have one, to avoid stacking
     * duplicates on repeat triggers. Never overwrites an occupied slot: tries
     * the last hotbar slot first (only if empty), then falls back to
     * {@link org.bukkit.inventory.PlayerInventory#addItem}, which itself only
     * fills empty slots and never displaces existing items (kits, compasses,
     * etc.) — if the inventory is completely full the item is simply not given.
     */
    public static void giveIfAbsent(Player player, ItemStack item) {
        if (player.getInventory().containsAtLeast(item, 1)) {
            return;
        }
        if (player.getInventory().getItem(PREFERRED_HOTBAR_SLOT) == null) {
            player.getInventory().setItem(PREFERRED_HOTBAR_SLOT, item);
            return;
        }
        player.getInventory().addItem(item);
    }

    public static void removeAll(Plugin plugin, Player player, boolean token) {
        for (ItemStack stack : player.getInventory().getContents()) {
            if (stack != null && (token ? isTokenItem(plugin, stack) : isRatingItem(plugin, stack))) {
                player.getInventory().remove(stack);
            }
        }
    }

    /** Fetches the live web balance and opens the token menu once it resolves. */
    public static void openTokenMenu(ZanderPGMPlugin plugin, Player player) {
        player.sendMessage("§7Checking your Map Token balance...");
        plugin.api().getMapTokens(player.getUniqueId().toString(), player.getName())
                .thenAccept(body -> Bukkit.getScheduler().runTask(plugin, () -> {
                    int balance = parseBalance(body);
                    new MapTokenMenu(plugin, player, balance).open(player);
                }));
    }

    private static int parseBalance(String body) {
        if (body == null) {
            return 0;
        }
        try {
            JsonObject json = JsonUtil.gson().fromJson(body, JsonObject.class);
            if (!json.has("success") || !json.get("success").getAsBoolean()) {
                return 0;
            }
            JsonObject data = json.getAsJsonObject("data");
            JsonObject balance = data.getAsJsonObject("balance");
            return balance != null && balance.has("balance") ? balance.get("balance").getAsInt() : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    public static void openRatingMenu(ZanderPGMPlugin plugin, Player player, String mapName) {
        new MapRatingMenu(plugin, mapName).open(player);
    }
}
