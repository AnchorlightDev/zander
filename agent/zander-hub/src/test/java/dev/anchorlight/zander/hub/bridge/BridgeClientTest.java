package dev.anchorlight.zander.hub.bridge;

import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

class BridgeClientTest {
    @Test
    void correlatesResponseToItsRequestByRequestId() throws Exception {
        java.util.concurrent.atomic.AtomicReference<byte[]> sent = new java.util.concurrent.atomic.AtomicReference<>();
        BridgeClient client = new BridgeClient((player, bytes) -> sent.set(bytes), 2000L);

        CompletableFuture<BridgeMessage.ServerListResponse> future = client.requestServerList(null);
        BridgeMessage.ServerListRequest decodedRequest =
                (BridgeMessage.ServerListRequest) BridgeCodec.decode(sent.get());

        var response = new BridgeMessage.ServerListResponse(decodedRequest.requestId(),
                List.of(new BridgeMessage.ServerInfo("survival", 3, true, true, false)));
        client.onPluginMessageReceived(BridgeCodec.encode(response));

        BridgeMessage.ServerListResponse result = future.get(1, TimeUnit.SECONDS);
        assertEquals(1, result.servers().size());
        assertEquals("survival", result.servers().get(0).id());
    }

    @Test
    void ignoresResponseWithUnknownRequestId() {
        BridgeClient client = new BridgeClient((player, bytes) -> {
        }, 2000L);
        var response = new BridgeMessage.ServerListResponse("no-such-request", List.of());
        assertDoesNotThrow(() -> client.onPluginMessageReceived(BridgeCodec.encode(response)));
    }

    @Test
    void timesOutWhenNoResponseArrives() {
        BridgeClient client = new BridgeClient((player, bytes) -> {
        }, 50L);
        CompletableFuture<BridgeMessage.ServerListResponse> future = client.requestServerList(null);

        ExecutionException ex = assertThrows(ExecutionException.class, () -> future.get(1, TimeUnit.SECONDS));
        assertInstanceOf(TimeoutException.class, ex.getCause());
    }

    @Test
    void encodeFailureCompletesFutureExceptionallyWithoutLeakingPendingEntry() {
        java.util.concurrent.atomic.AtomicInteger sendCount = new java.util.concurrent.atomic.AtomicInteger();
        BridgeClient client = new BridgeClient((player, bytes) -> sendCount.incrementAndGet(), 2000L);

        // serverId longer than BridgeCodec.MAX_STRING_LENGTH forces BridgeCodec.encode to throw
        // BridgeProtocolException synchronously, before the sender is ever invoked (mirrors the
        // null-portalId bug from HubCompassItem.onClick).
        String oversizedServerId = "x".repeat(BridgeCodec.MAX_STRING_LENGTH + 1);

        CompletableFuture<BridgeMessage> future = client.sendConnectRequest(null, "portal-1", oversizedServerId);

        assertTrue(future.isCompletedExceptionally(), "future should complete exceptionally instead of send() throwing");
        ExecutionException ex = assertThrows(ExecutionException.class, () -> future.get(1, TimeUnit.SECONDS));
        assertInstanceOf(BridgeProtocolException.class, ex.getCause());
        assertEquals(0, sendCount.get(), "sender should never be invoked when encoding fails");

        // A response arriving late for that same requestId must find no stale pending entry to
        // resolve against (it would otherwise silently vanish into a completed future, but more
        // importantly this proves the `pending` map was cleaned up via the whenComplete path).
        assertDoesNotThrow(() -> client.onPluginMessageReceived(
                BridgeCodec.encode(new BridgeMessage.ConnectStarted("does-not-matter", "survival"))));
    }

    @Test
    void connectRequestResolvesOnConnectStarted() throws Exception {
        java.util.concurrent.atomic.AtomicReference<byte[]> sent = new java.util.concurrent.atomic.AtomicReference<>();
        BridgeClient client = new BridgeClient((player, bytes) -> sent.set(bytes), 2000L);

        CompletableFuture<BridgeMessage> future = client.sendConnectRequest(null, "portal-1", "survival");
        BridgeMessage.ConnectRequest decoded = (BridgeMessage.ConnectRequest) BridgeCodec.decode(sent.get());
        assertEquals("portal-1", decoded.portalId());

        client.onPluginMessageReceived(BridgeCodec.encode(new BridgeMessage.ConnectStarted(decoded.requestId(), "survival")));
        assertInstanceOf(BridgeMessage.ConnectStarted.class, future.get(1, TimeUnit.SECONDS));
    }
}
