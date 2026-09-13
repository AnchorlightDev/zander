package dev.anchorlight.zander.hub.portal;

import dev.anchorlight.zander.hub.ZanderHubMain;
import dev.anchorlight.zander.hub.bridge.BridgeClient;
import dev.anchorlight.zander.hub.bridge.BridgeMessage;
import net.kyori.adventure.text.minimessage.MiniMessage;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Sound;
import org.bukkit.World;
import org.bukkit.entity.Player;

/**
 * Executes a portal's destination once {@link PortalMovementListener} has confirmed entry:
 * either a local teleport or a bridge-mediated server-transfer request. Server access is
 * never decided here — only Velocity's response determines the outcome.
 */
public class PortalActivationHandler {
    private final ZanderHubMain plugin;
    private final PortalSessionManager sessions;
    private final BridgeClient bridgeClient;

    public PortalActivationHandler(ZanderHubMain plugin, PortalSessionManager sessions, BridgeClient bridgeClient) {
        this.plugin = plugin;
        this.sessions = sessions;
        this.bridgeClient = bridgeClient;
    }

    public void activate(Player player, Portal portal) {
        long now = System.currentTimeMillis();

        if (!portal.enabled()) {
            send(player, "messages.portal.disabled", "<red>This portal is currently disabled.</red>");
            return;
        }
        if (sessions.isOnCooldown(player.getUniqueId(), portal.id(), now)) {
            send(player, "messages.portal.cooldown", "<gray>Please wait before using this portal again.</gray>");
            return;
        }
        if (portal.permission() != null && !player.hasPermission(portal.permission())) {
            send(player, "messages.portal.permission-denied", "<red>You do not have permission to use this portal.</red>");
            return;
        }

        switch (portal.destination()) {
            case ServerPortalDestination server -> activateServer(player, portal, server);
            case LocationPortalDestination location -> activateLocation(player, portal, location);
        }
    }

    private void activateServer(Player player, Portal portal, ServerPortalDestination destination) {
        if (!sessions.tryMarkConnectPending(player.getUniqueId())) {
            return; // a request is already in flight for this player
        }

        sessions.markTriggered(player.getUniqueId(), portal.id(), System.currentTimeMillis(), portal.cooldownMs());

        send(player, "messages.portal.connection-started", "<yellow>Connecting you now...</yellow>");

        bridgeClient.sendConnectRequest(player, portal.id(), destination.serverId())
                .whenComplete((response, error) -> Bukkit.getScheduler().runTask(plugin, () -> {
                    sessions.clearConnectPending(player.getUniqueId());
                    if (!player.isOnline()) {
                        return;
                    }
                    if (error != null) {
                        send(player, "messages.portal.connection-failed", "<red>Failed to connect, please try again.</red>");
                        return;
                    }
                    switch (response) {
                        case BridgeMessage.ConnectStarted ignored -> playSound(player, portal);
                        case BridgeMessage.ConnectDenied denied ->
                                player.sendMessage(MiniMessage.miniMessage().deserialize(
                                        denied.reason().isBlank() ? "<red>Access denied.</red>" : "<red>" + denied.reason() + "</red>"));
                        case BridgeMessage.ConnectFailed failed ->
                                player.sendMessage(MiniMessage.miniMessage().deserialize(
                                        failed.reason().isBlank() ? "<red>Connection failed.</red>" : "<red>" + failed.reason() + "</red>"));
                        default -> { }
                    }
                }));
    }

    private void activateLocation(Player player, Portal portal, LocationPortalDestination destination) {
        sessions.markTriggered(player.getUniqueId(), portal.id(), System.currentTimeMillis(), portal.cooldownMs());

        World world = Bukkit.getWorld(destination.world());
        if (world == null) {
            send(player, "messages.portal.local-teleport-failed", "<red>That destination is currently unavailable.</red>");
            return;
        }

        int reentryDelayTicks = plugin.getConfig().getInt("portals.reentry-delay-ticks", 2);
        long suppressUntil = System.currentTimeMillis() + (reentryDelayTicks * 50L);
        sessions.suppressUntil(player.getUniqueId(), suppressUntil);

        Location target = new Location(world, destination.x(), destination.y(), destination.z(),
                destination.yaw(), destination.pitch());
        player.teleportAsync(target).thenAccept(success -> {
            if (Boolean.TRUE.equals(success)) {
                Bukkit.getScheduler().runTask(plugin, () -> {
                    player.sendMessage(MiniMessage.miniMessage().deserialize(portal.successMessage()));
                    playSound(player, portal);
                });
            } else {
                Bukkit.getScheduler().runTask(plugin, () ->
                        send(player, "messages.portal.local-teleport-failed", "<red>That destination is currently unavailable.</red>"));
            }
        });
    }

    private void playSound(Player player, Portal portal) {
        if (portal.sound() == null) {
            return;
        }
        try {
            player.playSound(player.getLocation(), Sound.valueOf(portal.sound()), 1f, 1f);
        } catch (IllegalArgumentException ignored) {
            // invalid sound values are already rejected at load time by PortalRepository
        }
    }

    private void send(Player player, String configPath, String fallback) {
        String message = plugin.getConfig().getString(configPath, fallback);
        player.sendMessage(MiniMessage.miniMessage().deserialize(message));
    }
}
