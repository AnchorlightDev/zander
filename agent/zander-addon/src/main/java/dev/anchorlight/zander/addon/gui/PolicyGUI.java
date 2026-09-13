package dev.anchorlight.zander.addon.gui;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import dev.anchorlight.zander.addon.ZanderAddonMain;

import java.util.List;

public class PolicyGUI implements Listener {
    private final ZanderAddonMain plugin;
    private final Component inventoryTitle = Component.text("Server Policies", NamedTextColor.DARK_BLUE);

    public PolicyGUI(ZanderAddonMain plugin) {
        this.plugin = plugin;
    }

    public void open(Player player) {
        Inventory gui = Bukkit.createInventory(null, 9, inventoryTitle);

        gui.setItem(1, createPolicyItem(Material.BOOK, "Terms of Service"));
        gui.setItem(3, createPolicyItem(Material.BOOK, "Rules"));
        gui.setItem(5, createPolicyItem(Material.BOOK, "Privacy Policy"));
        gui.setItem(7, createPolicyItem(Material.BOOK, "Refund Policy"));

        player.openInventory(gui);
    }

    private ItemStack createPolicyItem(Material material, String name) {
        ItemStack item = new ItemStack(material);
        ItemMeta meta = item.getItemMeta();
        meta.displayName(Component.text(name, NamedTextColor.GOLD));
        meta.lore(List.of(Component.text("Click to read our " + name, NamedTextColor.GRAY)));
        item.setItemMeta(meta);
        return item;
    }

    @EventHandler
    public void onInventoryClick(InventoryClickEvent event) {
        // Use Component comparison properly or check inventory instance/holder if applicable.
        // For now, title comparison via Adventure should be fine if used correctly.
        if (!event.getView().title().equals(inventoryTitle)) {
            return;
        }

        event.setCancelled(true);
        if (!(event.getWhoClicked() instanceof Player player)) {
            return;
        }

        ItemStack clickedItem = event.getCurrentItem();
        if (clickedItem == null || clickedItem.getType() != Material.BOOK) {
            return;
        }

        int slot = event.getRawSlot();
        String type = null;
        if (slot == 1) type = "tos";
        else if (slot == 3) type = "rules";
        else if (slot == 5) type = "privacy";
        else if (slot == 7) type = "refund";

        if (type != null) {
            player.closeInventory();
            player.performCommand("policy " + type);
        }
    }
}
