package dev.anchorlight.zander.hub.commands;

import dev.anchorlight.zander.hub.ZanderHubMain;
import dev.anchorlight.zander.hub.bridge.BridgeMessage;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.jetbrains.annotations.NotNull;

import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * /connect <server> — asks the proxy to move the player to another server.
 *
 * Uses the same hub bridge request as the navigation compass, so the proxy
 * (zander-velocity's HubBridgeListener) stays the only authority: it rejects
 * unknown servers, enforces serverpermissions.server.<id> and rate-limits.
 * Nothing is decided here.
 */
public class connect implements CommandExecutor {
    private final Set<UUID> pending = ConcurrentHashMap.newKeySet();

    @Override
    public boolean onCommand(@NotNull CommandSender sender, @NotNull Command cmd, @NotNull String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage("You must be a player to use this command.");
            return true;
        }
        if (args.length != 1 || args[0].isBlank()) {
            player.sendMessage(Component.text("Usage: /" + label + " <server>", NamedTextColor.RED));
            return true;
        }
        if (ZanderHubMain.bridgeClient == null) {
            player.sendMessage(Component.text("Server switching is unavailable right now.", NamedTextColor.RED));
            return true;
        }

        UUID playerId = player.getUniqueId();
        if (!pending.add(playerId)) {
            return true; // a request is already in flight
        }

        String serverId = args[0].trim();
        ZanderHubMain.bridgeClient.sendConnectRequest(player, "", serverId)
                .whenComplete((response, error) -> Bukkit.getScheduler().runTask(ZanderHubMain.plugin, () -> {
                    pending.remove(playerId);
                    if (!player.isOnline()) {
                        return;
                    }
                    if (error != null) {
                        player.sendMessage(Component.text("Failed to connect, please try again.", NamedTextColor.RED));
                        return;
                    }
                    switch (response) {
                        case BridgeMessage.ConnectStarted ignored ->
                                player.sendMessage(Component.text("Connecting you to " + serverId + "...", NamedTextColor.YELLOW));
                        case BridgeMessage.ConnectDenied denied ->
                                player.sendMessage(Component.text(denied.reason(), NamedTextColor.RED));
                        case BridgeMessage.ConnectFailed failed ->
                                player.sendMessage(Component.text(failed.reason(), NamedTextColor.RED));
                        default -> { }
                    }
                }));
        return true;
    }
}
