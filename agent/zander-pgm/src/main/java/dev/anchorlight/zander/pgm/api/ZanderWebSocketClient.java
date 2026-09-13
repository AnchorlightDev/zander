package dev.anchorlight.zander.pgm.api;

import com.google.gson.JsonObject;
import dev.anchorlight.stonelib.http.ConnectionHealth;
import dev.anchorlight.zander.pgm.config.ZanderPGMConfig;
import dev.anchorlight.zander.pgm.api.dto.BridgeEvent;
import dev.anchorlight.zander.pgm.util.JsonUtil;
import dev.anchorlight.zander.pgm.util.SafeLogger;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * Optional WebSocket link to zander-web. Sends outbound events as fire-and-forget
 * JSON and dispatches inbound control messages (PING, REQUEST_*, MAP_TOKEN_REQUEST,
 * START/CANCEL/FORCE_END_MAP_VOTE) to a registered handler. Reconnection is driven
 * externally by {@code /zpgm reconnect} and the heartbeat task.
 */
public class ZanderWebSocketClient {

    private final ZanderPGMConfig config;
    private final ConnectionHealth health;
    private final SafeLogger logger;
    private final Consumer<JsonObject> inboundHandler;
    private final HttpClient http;
    private final AtomicReference<WebSocket> socket = new AtomicReference<>();
    private volatile boolean shuttingDown;

    public ZanderWebSocketClient(ZanderPGMConfig config, ConnectionHealth health, SafeLogger logger,
                                 Consumer<JsonObject> inboundHandler) {
        this.config = config;
        this.health = health;
        this.logger = logger;
        this.inboundHandler = inboundHandler;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(config.connectTimeoutSeconds))
                .build();
    }

    public void connect() {
        if (config.websocketUrl == null || config.websocketUrl.isBlank()) {
            return;
        }
        shuttingDown = false;
        try {
            http.newWebSocketBuilder()
                    .header("Authorization", "Bearer " + config.token)
                    .header("X-Server-Id", config.serverId)
                    .buildAsync(URI.create(config.websocketUrl), new Listener())
                    .whenComplete((ws, err) -> {
                        if (err != null) {
                            health.setStreamConnected(false);
                            logger.debug("WebSocket connect failed: " + err.getMessage());
                        } else {
                            socket.set(ws);
                            health.setStreamConnected(true);
                            logger.info("WebSocket connected to " + config.websocketUrl);
                        }
                    });
        } catch (Exception e) {
            logger.debug("WebSocket connect threw: " + e.getMessage());
        }
    }

    public void reconnect() {
        close();
        connect();
    }

    public void send(BridgeEvent event) {
        WebSocket ws = socket.get();
        if (ws == null) {
            return;
        }
        try {
            ws.sendText(JsonUtil.toJson(event), true);
        } catch (Exception e) {
            logger.debug("WebSocket send failed: " + e.getMessage());
        }
    }

    public boolean isConnected() {
        return health.isStreamConnected();
    }

    public void close() {
        shuttingDown = true;
        WebSocket ws = socket.getAndSet(null);
        if (ws != null) {
            try {
                ws.sendClose(WebSocket.NORMAL_CLOSURE, "shutdown");
            } catch (Exception ignored) {
            }
        }
        health.setStreamConnected(false);
    }

    private final class Listener implements WebSocket.Listener {
        private final StringBuilder buffer = new StringBuilder();

        @Override
        public void onOpen(WebSocket webSocket) {
            health.setStreamConnected(true);
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            buffer.append(data);
            if (last) {
                String message = buffer.toString();
                buffer.setLength(0);
                try {
                    JsonObject obj = JsonUtil.gson().fromJson(message, JsonObject.class);
                    if (obj != null) {
                        inboundHandler.accept(obj);
                    }
                } catch (Exception e) {
                    logger.debug("Bad WebSocket message: " + e.getMessage());
                }
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            health.setStreamConnected(false);
            if (!shuttingDown) {
                logger.debug("WebSocket closed (" + statusCode + "): " + reason);
            }
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            health.setStreamConnected(false);
            logger.debug("WebSocket error: " + error.getMessage());
        }
    }
}
