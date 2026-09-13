package dev.anchorlight.zander.addon.events;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import dev.anchorlight.zander.addon.ZanderAddonMain;
import dev.anchorlight.zander.addon.gui.PolicyGUI;
import dev.anchorlight.zander.addon.gui.SocialGUI;

import java.util.List;

public class PlayerEvents implements Listener {
    private final ZanderAddonMain plugin;
    private final PolicyGUI policyGUI;
    private final SocialGUI socialGUI;
    private final NamespacedKey policyBookKey;
    private final NamespacedKey socialPaperKey;

    public PlayerEvents(ZanderAddonMain plugin, PolicyGUI policyGUI, SocialGUI socialGUI) {
        this.plugin = plugin;
        this.policyGUI = policyGUI;
        this.socialGUI = socialGUI;
        this.policyBookKey = new NamespacedKey(plugin, "policy_book");
        this.socialPaperKey = new NamespacedKey(plugin, "social_paper");
    }

    /// Runs at HIGH priority so items are given after other plugins
    /// (e.g. zander-hub) clear the player's inventory on join.
    @EventHandler(priority = EventPriority.HIGH)
    public void onPlayerJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        if (plugin.getConfig().getBoolean("policy-book.enabled", true)) {
            givePolicyBook(player);
        }
        if (plugin.getConfig().getBoolean("social-paper.enabled", true)) {
            giveSocialPaper(player);
        }
    }

    private void givePolicyBook(Player player) {
        int slot = plugin.getConfig().getInt("policy-book.slot", 8);
        ItemStack currentItem = player.getInventory().getItem(slot);

        // Only overwrite if slot is empty or already has our policy book
        if (currentItem != null && currentItem.getType() != Material.AIR) {
            ItemMeta currentMeta = currentItem.getItemMeta();
            if (currentMeta == null || !currentMeta.getPersistentDataContainer().has(policyBookKey, PersistentDataType.BYTE)) {
                return;
            }
        }

        ItemStack book = new ItemStack(Material.BOOK);
        ItemMeta meta = book.getItemMeta();
        meta.displayName(Component.text("Server Policies", NamedTextColor.GOLD));
        meta.lore(List.of(Component.text("Right-click to view server policies", NamedTextColor.GRAY)));
        meta.getPersistentDataContainer().set(policyBookKey, PersistentDataType.BYTE, (byte) 1);
        book.setItemMeta(meta);

        player.getInventory().setItem(slot, book);
    }

    private void giveSocialPaper(Player player) {
        int slot = plugin.getConfig().getInt("social-paper.slot", 7);
        ItemStack currentItem = player.getInventory().getItem(slot);

        if (currentItem != null && currentItem.getType() != Material.AIR) {
            ItemMeta currentMeta = currentItem.getItemMeta();
            if (currentMeta == null || !currentMeta.getPersistentDataContainer().has(socialPaperKey, PersistentDataType.BYTE)) {
                return;
            }
        }

        ItemStack paper = new ItemStack(Material.PAPER);
        ItemMeta meta = paper.getItemMeta();
        meta.displayName(Component.text("Social Media", NamedTextColor.LIGHT_PURPLE));
        meta.lore(List.of(Component.text("Right-click to view our social media", NamedTextColor.GRAY)));
        meta.getPersistentDataContainer().set(socialPaperKey, PersistentDataType.BYTE, (byte) 1);
        paper.setItemMeta(meta);

        player.getInventory().setItem(slot, paper);
    }

    @EventHandler
    public void onPlayerInteract(PlayerInteractEvent event) {
        if (event.getAction() == Action.RIGHT_CLICK_AIR || event.getAction() == Action.RIGHT_CLICK_BLOCK) {
            ItemStack item = event.getItem();
            if (item != null) {
                ItemMeta meta = item.getItemMeta();
                if (meta == null) return;

                if (meta.getPersistentDataContainer().has(policyBookKey, PersistentDataType.BYTE)) {
                    policyGUI.open(event.getPlayer());
                    event.setCancelled(true);
                } else if (meta.getPersistentDataContainer().has(socialPaperKey, PersistentDataType.BYTE)) {
                    socialGUI.open(event.getPlayer());
                    event.setCancelled(true);
                }
            }
        }
    }
}
