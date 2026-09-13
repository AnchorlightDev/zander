package dev.anchorlight.zander.velocity.bridge;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class BridgeCodecTest {
    @Test
    void roundTripsServerListRequest() {
        var original = new BridgeMessage.ServerListRequest("req-1");
        assertEquals(original, BridgeCodec.decode(BridgeCodec.encode(original)));
    }

    @Test
    void roundTripsServerListResponseWithMultipleServers() {
        var servers = List.of(
                new BridgeMessage.ServerInfo("survival", 12, true, true, false),
                new BridgeMessage.ServerInfo("events", 0, false, false, false));
        var original = new BridgeMessage.ServerListResponse("req-2", servers);
        assertEquals(original, BridgeCodec.decode(BridgeCodec.encode(original)));
    }

    @Test
    void roundTripsConnectRequest() {
        var original = new BridgeMessage.ConnectRequest("req-3", "survival-portal", "survival");
        assertEquals(original, BridgeCodec.decode(BridgeCodec.encode(original)));
    }

    @Test
    void roundTripsConnectFailed() {
        var original = new BridgeMessage.ConnectFailed("req-4", "Server unavailable");
        assertEquals(original, BridgeCodec.decode(BridgeCodec.encode(original)));
    }

    @Test
    void rejectsUnsupportedProtocolVersion() {
        byte[] encoded = BridgeCodec.encode(new BridgeMessage.ServerListRequest("req-5"));
        encoded[0] = (byte) 99;
        assertThrows(BridgeProtocolException.class, () -> BridgeCodec.decode(encoded));
    }

    @Test
    void rejectsTruncatedPayload() {
        byte[] encoded = BridgeCodec.encode(new BridgeMessage.ConnectRequest("req-6", "p", "s"));
        byte[] truncated = java.util.Arrays.copyOf(encoded, encoded.length - 3);
        assertThrows(BridgeProtocolException.class, () -> BridgeCodec.decode(truncated));
    }

    @Test
    void rejectsOversizedString() {
        String tooLong = "x".repeat(BridgeCodec.MAX_STRING_LENGTH + 1);
        var oversized = new BridgeMessage.ConnectRequest("req-7", tooLong, "s");
        assertThrows(BridgeProtocolException.class, () -> BridgeCodec.encode(oversized));
    }
}
