package dev.anchorlight.zander.hub.bridge;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class BridgeCodecTest {
    @Test
    void roundTripsServerListRequest() {
        BridgeMessage.ServerListRequest original = new BridgeMessage.ServerListRequest("req-1");
        byte[] encoded = BridgeCodec.encode(original);
        BridgeMessage decoded = BridgeCodec.decode(encoded);
        assertEquals(original, decoded);
    }

    @Test
    void roundTripsServerListResponseWithMultipleServers() {
        var servers = List.of(
                new BridgeMessage.ServerInfo("survival", 12, true, true, false),
                new BridgeMessage.ServerInfo("events", 0, false, false, false));
        var original = new BridgeMessage.ServerListResponse("req-2", servers);
        BridgeMessage decoded = BridgeCodec.decode(BridgeCodec.encode(original));
        assertEquals(original, decoded);
    }

    @Test
    void roundTripsConnectRequest() {
        var original = new BridgeMessage.ConnectRequest("req-3", "survival-portal", "survival");
        assertEquals(original, BridgeCodec.decode(BridgeCodec.encode(original)));
    }

    @Test
    void roundTripsConnectDenied() {
        var original = new BridgeMessage.ConnectDenied("req-4", "No permission");
        assertEquals(original, BridgeCodec.decode(BridgeCodec.encode(original)));
    }

    @Test
    void rejectsUnsupportedProtocolVersion() {
        byte[] encoded = BridgeCodec.encode(new BridgeMessage.ServerListRequest("req-5"));
        encoded[0] = (byte) 99; // corrupt the version byte
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

    @Test
    void rejectsEmptyByteArray() {
        assertThrows(BridgeProtocolException.class, () -> BridgeCodec.decode(new byte[0]));
    }
}
