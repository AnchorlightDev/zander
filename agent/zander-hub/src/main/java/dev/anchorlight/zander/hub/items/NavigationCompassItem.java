package dev.anchorlight.zander.hub.items;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.event.Listener;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import dev.anchorlight.zander.hub.ZanderHubMain;
import dev.anchorlight.stonelib.ItemBuilder;

public class NavigationCompassItem implements Listener {
    public static final NamespacedKey KEY = new NamespacedKey(ZanderHubMain.plugin, "navigation_compass");

    public static ItemStack createCompass() {
        ItemStack item = ItemBuilder.of(Material.COMPASS)
                .name(Component.text("Navigation Compass", NamedTextColor.AQUA, TextDecoration.BOLD))
                .lore(Component.text("Right Click me to access Servers", NamedTextColor.YELLOW))
                .build();
        ItemMeta meta = item.getItemMeta();
        meta.getPersistentDataContainer().set(KEY, PersistentDataType.BOOLEAN, true);
        item.setItemMeta(meta);
        return item;
    }

    /// Whether `item` is a tagged Zander navigation compass (not just any compass).
    public static boolean isNavigationCompass(ItemStack item) {
        if (item == null || !item.hasItemMeta()) {
            return false;
        }
        ItemMeta meta = item.getItemMeta();
        Boolean tagged = meta.getPersistentDataContainer().get(KEY, PersistentDataType.BOOLEAN);
        return Boolean.TRUE.equals(tagged);
    }
}
