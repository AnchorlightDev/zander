package dev.anchorlight.zander.velocity.bridge;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.PluginMessageEvent;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.ServerConnection;
import com.velocitypowered.api.proxy.messages.ChannelIdentifier;
import com.velocitypowered.api.proxy.messages.MinecraftChannelIdentifier;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import dev.anchorlight.stonelib.cooldown.RateLimiter;
import dev.dejvokep.boostedyaml.YamlDocument;
import dev.dejvokep.boostedyaml.route.Route;
import org.slf4j.Logger;

import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Handles the {@code zander:hub} bridge channel on the proxy: validates the source
 * backend server, derives the player from the connection (never trusting payload
 * identity), enforces {@code serverpermissions.server.<id>}, and is the sole authority
 * for whether a bridge-initiated connection actually proceeds.
 */
public class HubBridgeListener {
    public static final ChannelIdentifier CHANNEL = MinecraftChannelIdentifier.create("zander", "hub");

    private final ProxyServer proxy;
    private final Logger logger;
    private final boolean enabled;
    private final List<String> allowedSourceServers;
    private final boolean logMalformed;
    private final boolean logDeniedSources;
    private final RateLimiter rateLimiter;
    private final java.util.Set<String> recentlyLoggedDenials = ConcurrentHashMap.newKeySet();
    private final java.util.Set<UUID> recentlyLoggedMalformed = ConcurrentHashMap.newKeySet();

    public HubBridgeListener(ProxyServer proxy, Logger logger, YamlDocument config) {
        this.proxy = proxy;
        this.logger = logger;
        this.enabled = config.getBoolean(Route.from("hub-bridge", "enabled"), true);
        this.allowedSourceServers = config.getStringList(Route.from("hub-bridge", "allowed-source-servers"));
        this.logMalformed = config.getBoolean(Route.from("hub-bridge", "logging", "malformed-messages"), true);
        this.logDeniedSources = config.getBoolean(Route.from("hub-bridge", "logging", "denied-source-servers"), true);
        long cooldownMs = config.getLong(Route.from("hub-bridge", "rate-limit", "connection-request-cooldown-ms"), 1500L);
        this.rateLimiter = new RateLimiter(Duration.ofMillis(cooldownMs));
    }

    @Subscribe
    public void onPluginMessage(PluginMessageEvent event) {
        if (!enabled || !event.getIdentifier().equals(CHANNEL)) {
            return;
        }
        event.setResult(PluginMessageEvent.ForwardResult.handled());

        if (!(event.getSource() instanceof ServerConnection source)) {
            return; // never process messages whose source isn't a backend server connection
        }
        String sourceServerName = source.getServerInfo().getName();
        if (!allowedSourceServers.contains(sourceServerName)) {
            if (logDeniedSources && recentlyLoggedDenials.add(sourceServerName)) {
                logger.warn("Rejected zander:hub message from unapproved source server '{}'", sourceServerName);
                proxy.getScheduler().buildTask(this, () -> recentlyLoggedDenials.remove(sourceServerName))
                        .delay(30, TimeUnit.SECONDS).schedule();
            }
            return;
        }

        Player player = source.getPlayer();
        if (player == null) {
            return;
        }

        dev.anchorlight.zander.velocity.bridge.BridgeMessage message;
        try {
            message = BridgeCodec.decode(event.getData());
        } catch (BridgeProtocolException e) {
            if (logMalformed && recentlyLoggedMalformed.add(player.getUniqueId())) {
                logger.warn("Rejected malformed zander:hub message from {}: {}", player.getUsername(), e.getMessage());
                proxy.getScheduler().buildTask(this, () -> recentlyLoggedMalformed.remove(player.getUniqueId()))
                        .delay(30, TimeUnit.SECONDS).schedule();
            }
            return;
        }

        if (message instanceof dev.anchorlight.zander.velocity.bridge.BridgeMessage.ServerListRequest) {
            handleServerListRequest(player, message.requestId());
        } else if (message instanceof dev.anchorlight.zander.velocity.bridge.BridgeMessage.ConnectRequest connectRequest) {
            handleConnectRequest(player, connectRequest);
        } else if (message instanceof dev.anchorlight.zander.velocity.bridge.BridgeMessage.PlayerCurrentServerRequest) {
            handlePlayerCurrentServerRequest(player, message.requestId());
        } else {
            /* proxy never receives response-type messages */
        }
    }

    private void reply(Player player, dev.anchorlight.zander.velocity.bridge.BridgeMessage response) {
        player.getCurrentServer().ifPresent(server ->
                server.sendPluginMessage(CHANNEL, BridgeCodec.encode(response)));
    }

    private void handleServerListRequest(Player player, String requestId) {
        List<dev.anchorlight.zander.velocity.bridge.BridgeMessage.ServerInfo> infos = new java.util.ArrayList<>();
        String currentServerName = player.getCurrentServer().map(sc -> sc.getServerInfo().getName()).orElse(null);
        for (RegisteredServer server : proxy.getAllServers()) {
            String id = server.getServerInfo().getName();
            boolean hasAccess = player.hasPermission("serverpermissions.server." + id);
            boolean alreadyConnected = id.equals(currentServerName);
            int count = server.getPlayersConnected().size();
            infos.add(new dev.anchorlight.zander.velocity.bridge.BridgeMessage.ServerInfo(
                    id, count, true, hasAccess, alreadyConnected));
        }
        reply(player, new dev.anchorlight.zander.velocity.bridge.BridgeMessage.ServerListResponse(requestId, infos));
    }

    private void handlePlayerCurrentServerRequest(Player player, String requestId) {
        String currentServerName = player.getCurrentServer().map(sc -> sc.getServerInfo().getName()).orElse("");
        reply(player, new dev.anchorlight.zander.velocity.bridge.BridgeMessage.PlayerCurrentServerResponse(requestId, currentServerName));
    }

    private void handleConnectRequest(Player player,
            dev.anchorlight.zander.velocity.bridge.BridgeMessage.ConnectRequest request) {
        if (!rateLimiter.tryAcquire(player.getUniqueId())) {
            reply(player, new dev.anchorlight.zander.velocity.bridge.BridgeMessage.ConnectFailed(
                    request.requestId(), "You are connecting too quickly, please wait."));
            return;
        }

        Optional<RegisteredServer> target = proxy.getServer(request.serverId());
        if (target.isEmpty()) {
            reply(player, new dev.anchorlight.zander.velocity.bridge.BridgeMessage.ConnectFailed(
                    request.requestId(), "Unknown server: " + request.serverId()));
            return;
        }

        String currentServerName = player.getCurrentServer().map(sc -> sc.getServerInfo().getName()).orElse(null);
        if (request.serverId().equals(currentServerName)) {
            reply(player, new dev.anchorlight.zander.velocity.bridge.BridgeMessage.ConnectFailed(
                    request.requestId(), "Already connected to " + request.serverId()));
            return;
        }

        if (!player.hasPermission("serverpermissions.server." + request.serverId())) {
            reply(player, new dev.anchorlight.zander.velocity.bridge.BridgeMessage.ConnectDenied(
                    request.requestId(), "You do not have access to " + request.serverId() + "."));
            return;
        }

        reply(player, new dev.anchorlight.zander.velocity.bridge.BridgeMessage.ConnectStarted(
                request.requestId(), request.serverId()));

        player.createConnectionRequest(target.get()).connect().whenComplete((result, throwable) -> {
            if (throwable != null || result == null || !result.isSuccessful()) {
                reply(player, new dev.anchorlight.zander.velocity.bridge.BridgeMessage.ConnectFailed(
                        request.requestId(), "Failed to connect to " + request.serverId() + "."));
            }
        });
    }
}
