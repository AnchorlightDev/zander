package dev.anchorlight.zander.hub.protection.dimension;

import dev.anchorlight.zander.hub.ConfigurationManager;
import dev.anchorlight.zander.hub.ZanderHubMain;
import net.kyori.adventure.text.minimessage.MiniMessage;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerChangedWorldEvent;
import org.bukkit.event.player.PlayerPortalEvent;
import org.bukkit.event.player.PlayerTeleportEvent;

import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Level;

/**
 * Blocks Nether/End travel from the Hub via portal events, generic teleport events
 * (covering command/plugin-driven teleports), and a same-tick fallback correction
 * for any Nether/End world entry that slips past those checks.
 */
public class DimensionProtectionListener implements Listener {
    private final ZanderHubMain plugin;
    private final Set<UUID> correcting = ConcurrentHashMap.newKeySet();
    private final Set<UUID> recentlyWarned = ConcurrentHashMap.newKeySet();

    public DimensionProtectionListener(ZanderHubMain plugin) {
        this.plugin = plugin;
    }

    private boolean isBlocked(World.Environment environment) {
        var dimensions = ConfigurationManager.getDimensions();
        if (environment == World.Environment.NETHER) {
            return dimensions.isNetherBlocked();
        }
        if (environment == World.Environment.THE_END) {
            return dimensions.isEndBlocked();
        }
        return false;
    }

    private boolean hasBypass(Player player, World.Environment environment) {
        var dimensions = ConfigurationManager.getDimensions();
        if (environment == World.Environment.NETHER) {
            return dimensions.isNetherBypassAllowed() && player.hasPermission("zanderhub.nether.bypass");
        }
        if (environment == World.Environment.THE_END) {
            return dimensions.isEndBypassAllowed() && player.hasPermission("zanderhub.end.bypass");
        }
        return false;
    }

    private String messageFor(World.Environment environment) {
        var dimensions = ConfigurationManager.getDimensions();
        return environment == World.Environment.NETHER ? dimensions.getNetherMessage() : dimensions.getEndMessage();
    }

    private void deny(Player player, World.Environment environment) {
        player.sendMessage(MiniMessage.miniMessage().deserialize(messageFor(environment)));
    }

    @EventHandler(priority = EventPriority.HIGH)
    public void onPortal(PlayerPortalEvent event) {
        World destinationWorld = event.getTo() != null ? event.getTo().getWorld() : null;
        if (destinationWorld == null) {
            return;
        }
        World.Environment environment = destinationWorld.getEnvironment();
        if (!isBlocked(environment) || hasBypass(event.getPlayer(), environment)) {
            return;
        }
        event.setCancelled(true);
        deny(event.getPlayer(), environment);
    }

    @EventHandler(priority = EventPriority.HIGH)
    public void onTeleport(PlayerTeleportEvent event) {
        World destinationWorld = event.getTo() != null ? event.getTo().getWorld() : null;
        if (destinationWorld == null) {
            return;
        }
        World.Environment environment = destinationWorld.getEnvironment();
        if (!isBlocked(environment) || hasBypass(event.getPlayer(), environment)) {
            return;
        }
        event.setCancelled(true);
        deny(event.getPlayer(), environment);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onWorldChange(PlayerChangedWorldEvent event) {
        Player player = event.getPlayer();
        World.Environment environment = player.getWorld().getEnvironment();
        if (!isBlocked(environment) || hasBypass(player, environment)) {
            return;
        }

        UUID playerId = player.getUniqueId();
        if (!correcting.add(playerId)) {
            return; // already scheduled a correction for this player
        }

        if (recentlyWarned.add(playerId)) {
            plugin.getLogger().log(Level.WARNING,
                    "{0} entered blocked dimension world ''{1}'' ({2}); scheduling fallback teleport to Hub spawn.",
                    new Object[] { player.getName(), player.getWorld().getName(), environment });
            Bukkit.getScheduler().runTaskLater(plugin, () -> recentlyWarned.remove(playerId), 20L * 30L);
        }

        Bukkit.getScheduler().runTask(plugin, () -> {
            try {
                if (player.isOnline()) {
                    Location spawn = ConfigurationManager.getHubLocations().getSpawn();
                    player.teleportAsync(spawn);
                    deny(player, environment);
                }
            } finally {
                correcting.remove(playerId);
            }
        });
    }
}
