package dev.anchorlight.zander.hub.bridge;

import com.google.common.io.ByteArrayDataOutput;
import com.google.common.io.ByteStreams;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Binary codec for the {@code zander:hub} plugin messaging channel. No Java object
 * serialization; every message is `[version:byte][type:byte][requestId:UTF]...fields`.
 * This class is intentionally duplicated (not shared) between zander-hub and
 * zander-velocity — see the design doc for why there is no shared module.
 */
public final class BridgeCodec {
    public static final byte PROTOCOL_VERSION = 1;
    public static final int MAX_STRING_LENGTH = 64;
    public static final int MAX_REASON_LENGTH = 256;

    private enum Type {
        SERVER_LIST_REQUEST, SERVER_LIST_RESPONSE, CONNECT_REQUEST, CONNECT_STARTED,
        CONNECT_DENIED, CONNECT_FAILED, PLAYER_CURRENT_SERVER_REQUEST, PLAYER_CURRENT_SERVER_RESPONSE
    }

    private BridgeCodec() {
        throw new IllegalStateException("Utility class shouldn't be instantiated");
    }

    private static void writeString(ByteArrayDataOutput out, String value, int maxLength) {
        if (value == null || value.length() > maxLength) {
            throw new BridgeProtocolException("String exceeds max length " + maxLength + ": " + value);
        }
        out.writeUTF(value);
    }

    private static String readString(DataInputStream in, int maxLength) throws IOException {
        String value = in.readUTF();
        if (value.length() > maxLength) {
            throw new BridgeProtocolException("Decoded string exceeds max length " + maxLength);
        }
        return value;
    }

    public static byte[] encode(BridgeMessage message) {
        ByteArrayDataOutput out = ByteStreams.newDataOutput();
        out.writeByte(PROTOCOL_VERSION);

        switch (message) {
            case BridgeMessage.ServerListRequest m -> {
                out.writeByte(Type.SERVER_LIST_REQUEST.ordinal());
                writeString(out, m.requestId(), MAX_STRING_LENGTH);
            }
            case BridgeMessage.ServerListResponse m -> {
                out.writeByte(Type.SERVER_LIST_RESPONSE.ordinal());
                writeString(out, m.requestId(), MAX_STRING_LENGTH);
                out.writeInt(m.servers().size());
                for (BridgeMessage.ServerInfo server : m.servers()) {
                    writeString(out, server.id(), MAX_STRING_LENGTH);
                    out.writeInt(server.playerCount());
                    out.writeBoolean(server.registered());
                    out.writeBoolean(server.hasAccess());
                    out.writeBoolean(server.alreadyConnected());
                }
            }
            case BridgeMessage.ConnectRequest m -> {
                out.writeByte(Type.CONNECT_REQUEST.ordinal());
                writeString(out, m.requestId(), MAX_STRING_LENGTH);
                writeString(out, m.portalId(), MAX_STRING_LENGTH);
                writeString(out, m.serverId(), MAX_STRING_LENGTH);
            }
            case BridgeMessage.ConnectStarted m -> {
                out.writeByte(Type.CONNECT_STARTED.ordinal());
                writeString(out, m.requestId(), MAX_STRING_LENGTH);
                writeString(out, m.serverId(), MAX_STRING_LENGTH);
            }
            case BridgeMessage.ConnectDenied m -> {
                out.writeByte(Type.CONNECT_DENIED.ordinal());
                writeString(out, m.requestId(), MAX_STRING_LENGTH);
                writeString(out, m.reason(), MAX_REASON_LENGTH);
            }
            case BridgeMessage.ConnectFailed m -> {
                out.writeByte(Type.CONNECT_FAILED.ordinal());
                writeString(out, m.requestId(), MAX_STRING_LENGTH);
                writeString(out, m.reason(), MAX_REASON_LENGTH);
            }
            case BridgeMessage.PlayerCurrentServerRequest m -> {
                out.writeByte(Type.PLAYER_CURRENT_SERVER_REQUEST.ordinal());
                writeString(out, m.requestId(), MAX_STRING_LENGTH);
            }
            case BridgeMessage.PlayerCurrentServerResponse m -> {
                out.writeByte(Type.PLAYER_CURRENT_SERVER_RESPONSE.ordinal());
                writeString(out, m.requestId(), MAX_STRING_LENGTH);
                writeString(out, m.serverId(), MAX_STRING_LENGTH);
            }
        }
        return out.toByteArray();
    }

    public static BridgeMessage decode(byte[] bytes) {
        try {
            DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes));
            byte version = in.readByte();
            if (version != PROTOCOL_VERSION) {
                throw new BridgeProtocolException("Unsupported protocol version: " + version);
            }
            int typeOrdinal = in.readByte();
            Type[] types = Type.values();
            if (typeOrdinal < 0 || typeOrdinal >= types.length) {
                throw new BridgeProtocolException("Unknown message type ordinal: " + typeOrdinal);
            }
            Type type = types[typeOrdinal];
            String requestId = readString(in, MAX_STRING_LENGTH);

            return switch (type) {
                case SERVER_LIST_REQUEST -> new BridgeMessage.ServerListRequest(requestId);
                case SERVER_LIST_RESPONSE -> {
                    int count = in.readInt();
                    if (count < 0 || count > 4096) {
                        throw new BridgeProtocolException("Unreasonable server list count: " + count);
                    }
                    List<BridgeMessage.ServerInfo> servers = new ArrayList<>(count);
                    for (int i = 0; i < count; i++) {
                        servers.add(new BridgeMessage.ServerInfo(
                                readString(in, MAX_STRING_LENGTH), in.readInt(),
                                in.readBoolean(), in.readBoolean(), in.readBoolean()));
                    }
                    yield new BridgeMessage.ServerListResponse(requestId, servers);
                }
                case CONNECT_REQUEST -> new BridgeMessage.ConnectRequest(requestId,
                        readString(in, MAX_STRING_LENGTH), readString(in, MAX_STRING_LENGTH));
                case CONNECT_STARTED -> new BridgeMessage.ConnectStarted(requestId, readString(in, MAX_STRING_LENGTH));
                case CONNECT_DENIED -> new BridgeMessage.ConnectDenied(requestId, readString(in, MAX_REASON_LENGTH));
                case CONNECT_FAILED -> new BridgeMessage.ConnectFailed(requestId, readString(in, MAX_REASON_LENGTH));
                case PLAYER_CURRENT_SERVER_REQUEST -> new BridgeMessage.PlayerCurrentServerRequest(requestId);
                case PLAYER_CURRENT_SERVER_RESPONSE ->
                        new BridgeMessage.PlayerCurrentServerResponse(requestId, readString(in, MAX_STRING_LENGTH));
            };
        } catch (IOException e) {
            throw new BridgeProtocolException("Malformed or truncated bridge payload", e);
        }
    }
}
