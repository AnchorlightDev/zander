package dev.anchorlight.zander.hub.bridge;

import dev.anchorlight.stonelib.messaging.request.PendingRequests;
import org.bukkit.entity.Player;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

/**
 * Sends {@code zander:hub} bridge requests and resolves the matching response by
 * request id, using StoneLib's {@link PendingRequests} for correlation and timeouts.
 * Replaces the legacy BungeeCord-channel {@code ProxyMessaging}/{@code PluginMessageChannel} pair.
 */
public class BridgeClient {
    @FunctionalInterface
    public interface Sender {
        void send(Player player, byte[] bytes);
    }

    private final Sender sender;
    private final PendingRequests<BridgeMessage> pending;

    public BridgeClient(Sender sender, long timeoutMs) {
        this.sender = sender;
        this.pending = new PendingRequests<>(Duration.ofMillis(timeoutMs));
    }

    private <T extends BridgeMessage> CompletableFuture<T> send(Player player, Function<String, BridgeMessage> request) {
        return pending.send(requestId -> sender.send(player, BridgeCodec.encode(request.apply(requestId))));
    }

    public CompletableFuture<BridgeMessage.ServerListResponse> requestServerList(Player player) {
        return send(player, BridgeMessage.ServerListRequest::new);
    }

    public CompletableFuture<BridgeMessage.PlayerCurrentServerResponse> requestPlayerCurrentServer(Player player) {
        return send(player, BridgeMessage.PlayerCurrentServerRequest::new);
    }

    /** Resolves with whichever of ConnectStarted/ConnectDenied/ConnectFailed the proxy replies with. */
    public CompletableFuture<BridgeMessage> sendConnectRequest(Player player, String portalId, String serverId) {
        return send(player, requestId -> new BridgeMessage.ConnectRequest(requestId, portalId, serverId));
    }

    /** Feed a raw plugin-message payload received on the {@code zander:hub} channel. */
    public void onPluginMessageReceived(byte[] bytes) {
        BridgeMessage message;
        try {
            message = BridgeCodec.decode(bytes);
        } catch (BridgeProtocolException e) {
            return; // malformed inbound message from the proxy; nothing safe to correlate
        }
        pending.complete(message.requestId(), message);
    }

    /** Fails every in-flight request, for plugin shutdown. */
    public void cancelAll() {
        pending.cancelAll();
    }
}
