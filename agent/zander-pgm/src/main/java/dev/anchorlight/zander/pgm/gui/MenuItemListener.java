package dev.anchorlight.zander.pgm.gui;

import org.bukkit.GameMode;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.player.PlayerGameModeChangeEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;

/**
 * Gives/removes the Map Token item as players enter/leave spectator mode,
 * and opens the right menu on right-click. The Map Rating item is handed
 * out separately by MapRatingService when a rating session opens (it
 * already knows which players participated).
 */
public class MenuItemListener implements Listener {

    private final ZanderPGMPlugin plugin;

    public MenuItemListener(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onInteract(PlayerInteractEvent event) {
        if (event.getAction() != Action.RIGHT_CLICK_AIR && event.getAction() != Action.RIGHT_CLICK_BLOCK) {
            return;
        }
        Player player = event.getPlayer();
        var item = event.getItem();
        if (item == null) {
            return;
        }
        if (MenuItems.isTokenItem(plugin, item)) {
            event.setCancelled(true);
            if (!plugin.cfg().mapTokensEnabled || !plugin.cfg().feature("mapTokens")) {
                player.sendMessage("§cMap Tokens are currently disabled.");
                return;
            }
            MenuItems.openTokenMenu(plugin, player);
        } else if (MenuItems.isRatingItem(plugin, item)) {
            event.setCancelled(true);
            var session = plugin.ratings().current();
            String mapName = session != null ? session.mapName : "this map";
            MenuItems.openRatingMenu(plugin, player, mapName);
        }
    }

    @EventHandler
    public void onGameModeChange(PlayerGameModeChangeEvent event) {
        if (!plugin.cfg().mapTokensEnabled || !plugin.cfg().feature("mapTokens")) {
            return;
        }
        Player player = event.getPlayer();
        if (event.getNewGameMode() == GameMode.SPECTATOR) {
            MenuItems.giveIfAbsent(player, MenuItems.tokenItem(plugin));
        } else {
            MenuItems.removeAll(plugin, player, true);
        }
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        if (plugin.cfg().mapTokensEnabled && plugin.cfg().feature("mapTokens")
                && player.getGameMode() == GameMode.SPECTATOR) {
            MenuItems.giveIfAbsent(player, MenuItems.tokenItem(plugin));
        }
    }
}
