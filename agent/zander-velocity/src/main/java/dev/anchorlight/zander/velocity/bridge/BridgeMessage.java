package dev.anchorlight.zander.velocity.bridge;

import java.util.List;

/** The `zander:hub` bridge protocol's message types. See {@link BridgeCodec} for wire format. */
public sealed interface BridgeMessage {
    String requestId();

    record ServerInfo(String id, int playerCount, boolean registered, boolean hasAccess, boolean alreadyConnected) {
    }

    record ServerListRequest(String requestId) implements BridgeMessage {
    }

    record ServerListResponse(String requestId, List<ServerInfo> servers) implements BridgeMessage {
    }

    record ConnectRequest(String requestId, String portalId, String serverId) implements BridgeMessage {
    }

    record ConnectStarted(String requestId, String serverId) implements BridgeMessage {
    }

    record ConnectDenied(String requestId, String reason) implements BridgeMessage {
    }

    record ConnectFailed(String requestId, String reason) implements BridgeMessage {
    }

    record PlayerCurrentServerRequest(String requestId) implements BridgeMessage {
    }

    record PlayerCurrentServerResponse(String requestId, String serverId) implements BridgeMessage {
    }
}
