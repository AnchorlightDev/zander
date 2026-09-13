package dev.anchorlight.zander.hub.portal;

import dev.anchorlight.stonelib.region.RegionTracker;
import dev.anchorlight.zander.hub.ZanderHubMain;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/**
 * Bukkit-side glue: only re-evaluates portal membership when the player crosses a block
 * boundary, delegating enter/exit detection to StoneLib's {@link RegionTracker}.
 */
public class PortalMovementListener implements Listener {
    private final ZanderHubMain plugin;
    private final RegionTracker<Portal> tracker;
    private final PortalSessionManager sessions;
    private final PortalActivationHandler activationHandler;

    public PortalMovementListener(ZanderHubMain plugin, RegionTracker<Portal> tracker,
            PortalSessionManager sessions, PortalActivationHandler activationHandler) {
        this.plugin = plugin;
        this.tracker = tracker;
        this.sessions = sessions;
        this.activationHandler = activationHandler;
    }

    @EventHandler
    public void onMove(PlayerMoveEvent event) {
        Location from = event.getFrom();
        Location to = event.getTo();
        if (to == null) {
            return;
        }
        if (from.getBlockX() == to.getBlockX() && from.getBlockY() == to.getBlockY()
                && from.getBlockZ() == to.getBlockZ()) {
            return; // only re-check on block-coordinate change
        }

        Player player = event.getPlayer();
        if (!player.isValid() || !player.isOnline()) {
            return;
        }
        if (plugin.getConfig().getBoolean("portals.ignore-spectators", true)
                && player.getGameMode() == GameMode.SPECTATOR) {
            return;
        }

        handleBlockMove(player, to);
    }

    private void handleBlockMove(Player player, Location to) {
        tracker.update(player.getUniqueId(), to.getWorld().getName(),
                to.getBlockX(), to.getBlockY(), to.getBlockZ()).entered().ifPresent(portal -> {
            if (sessions.isSuppressed(player.getUniqueId(), System.currentTimeMillis())) {
                return; // just teleported here by another portal; don't chain-trigger
            }
            activationHandler.activate(player, portal);
        });
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        tracker.clear(event.getPlayer().getUniqueId());
        sessions.clear(event.getPlayer().getUniqueId());
    }
}
