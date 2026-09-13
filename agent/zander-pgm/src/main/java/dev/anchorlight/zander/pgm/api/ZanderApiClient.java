package dev.anchorlight.zander.pgm.api;

import dev.anchorlight.stonelib.http.ApiClient;
import dev.anchorlight.stonelib.http.ConnectionHealth;
import dev.anchorlight.stonelib.http.RetryQueue;
import dev.anchorlight.zander.pgm.config.ZanderPGMConfig;
import dev.anchorlight.zander.pgm.api.dto.BridgeEvent;
import dev.anchorlight.zander.pgm.util.JsonUtil;
import dev.anchorlight.zander.pgm.util.SafeLogger;
import dev.anchorlight.zander.pgm.util.TimeUtil;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * REST client for zander-web Mixed ingestion endpoints, built on StoneLib's {@link ApiClient}:
 * all calls run off the main thread and never throw into the caller. Failed generic events are
 * pushed onto the {@link RetryQueue} for later retry.
 */
public class ZanderApiClient {

    private final ZanderPGMConfig config;
    private final RetryQueue<BridgeEvent> queue;
    private final SafeLogger logger;
    private final String pluginVersion;
    private final ApiClient http;

    public ZanderApiClient(ZanderPGMConfig config, ConnectionHealth health, RetryQueue<BridgeEvent> queue,
                           SafeLogger logger, String pluginVersion) {
        this.config = config;
        this.queue = queue;
        this.logger = logger;
        this.pluginVersion = pluginVersion;
        this.http = ApiClient.builder(config.baseUrl)
                .connectTimeout(Duration.ofSeconds(config.connectTimeoutSeconds))
                .requestTimeout(Duration.ofSeconds(config.requestTimeoutSeconds))
                .bearerToken(config.token)
                .header("X-Server-Id", config.serverId)
                .header("X-Plugin-Version", pluginVersion)
                .health(health)
                .logger(logger.logger())
                .debug(logger.isDebug())
                .build();
    }

    private void stamp(BridgeEvent event) {
        event.serverId = config.serverId;
        event.pluginVersion = pluginVersion;
        if (event.timestamp == 0) {
            event.timestamp = TimeUtil.now();
        }
    }

    /** POST an arbitrary body to a path. Never throws; returns success flag. */
    public CompletableFuture<Boolean> post(String path, Object body) {
        String json;
        try {
            json = JsonUtil.toJson(body);
        } catch (Exception e) {
            logger.warn("Failed to serialise POST " + path + ": " + e.getMessage());
            return CompletableFuture.completedFuture(false);
        }
        return http.post(path, json);
    }

    /** GET a path and return the response body, or null on failure. */
    public CompletableFuture<String> get(String path) {
        return http.get(path);
    }

    /**
     * Send a generic bridge event to {@code /api/mixed/events}. On failure the
     * event is queued for retry when {@code retryFailedEvents} is enabled.
     */
    public void send(BridgeEvent event) {
        stamp(event);
        post("/api/mixed/events", event).thenAccept(ok -> {
            if (!ok) {
                if (config.retryFailedEvents) {
                    logger.warn("Queuing " + event.type + " event for retry (queue size " + queue.size() + ")");
                    queue.offer(event);
                } else {
                    logger.warn("Dropping " + event.type + " event (retryFailedEvents disabled)");
                }
            }
        });
    }

    /** Attempt to send a batch; returns whether the whole batch succeeded. */
    public CompletableFuture<Boolean> sendBatch(List<BridgeEvent> events) {
        for (BridgeEvent e : events) {
            stamp(e);
        }
        return post("/api/mixed/events/batch", events);
    }

    // --- Specialised endpoints -------------------------------------------------

    public void heartbeat(BridgeEvent event) {
        stamp(event);
        post("/api/mixed/servers/heartbeat", event);
    }

    public CompletableFuture<Boolean> offline(BridgeEvent event) {
        stamp(event);
        return post("/api/mixed/servers/offline", event);
    }

    public void statsPlayer(Object dto) {
        post("/api/mixed/stats/player", dto);
    }

    public void statsMatch(Object dto) {
        post("/api/mixed/stats/match", dto);
    }

    public void statsMap(Object dto) {
        post("/api/mixed/stats/map", dto);
    }

    public void xp(Object dto) {
        post("/api/mixed/xp", dto);
    }

    public void achievement(Object dto) {
        post("/api/mixed/achievements", dto);
    }

    public CompletableFuture<String> pendingMapTokenRequests() {
        return get("/api/mixed/map-token-requests/pending");
    }

    public void mapTokenResult(String id, Object dto) {
        post("/api/mixed/map-token-requests/" + id + "/result", dto);
    }

    /** Fetches a player's live Map Token balance from the web-side ledger. */
    public CompletableFuture<String> getMapTokens(String uuid, String username) {
        return get("/api/mixed/map-tokens/balance?uuid=" + uuid + "&username=" + username);
    }

    /**
     * Submits a self-service Map Token spend (nominate/set_next/sponsor) against the web-side ledger.
     * Completes with the response body whatever its status, since rejections are explained there,
     * or null when no response arrived.
     */
    public CompletableFuture<String> requestMapToken(String uuid, String username, String mapKey, String actionType) {
        Map<String, Object> body = new HashMap<>();
        body.put("uuid", uuid);
        body.put("username", username);
        body.put("mapKey", mapKey);
        body.put("action", actionType);
        String json;
        try {
            json = JsonUtil.toJson(body);
        } catch (Exception e) {
            logger.warn("Failed to build map token request: " + e.getMessage());
            return CompletableFuture.completedFuture(null);
        }
        return http.send("POST", "/api/mixed/map-tokens/request", json)
                .thenApply(response -> response.map(ApiClient.Response::body).orElse(null));
    }

    public CompletableFuture<String> currentVote() {
        return get("/api/mixed/vote/current");
    }

    public void castVote(Object dto) {
        post("/api/mixed/vote/cast", dto);
    }

    public void submitRating(String mapKey, Object dto) {
        post("/api/mixed/maps/" + mapKey + "/ratings", dto);
    }
}
