package dev.anchorlight.zander.pgm.tokens;

import org.bukkit.Bukkit;
import org.bukkit.plugin.Plugin;
import dev.anchorlight.zander.pgm.api.ZanderApiClient;
import dev.anchorlight.zander.pgm.api.ZanderWebSocketClient;
import dev.anchorlight.zander.pgm.api.dto.MapTokenRequestEventDto;
import dev.anchorlight.zander.pgm.api.dto.MapTokensBalanceEventDto;
import dev.anchorlight.zander.pgm.config.ZanderPGMConfig;
import dev.anchorlight.zander.pgm.pgm.MapRotationService;
import dev.anchorlight.zander.pgm.util.AsyncUtil;
import dev.anchorlight.zander.pgm.util.SafeLogger;
import dev.anchorlight.zander.pgm.util.TimeUtil;
import dev.anchorlight.zander.pgm.voting.MapVoteService;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Applies remote Map Token requests (nominate/set-next/sponsor) to the match
 * rotation and vote service. Balances and transaction history live entirely
 * on zander-web — this plugin never keeps its own copy of the ledger; see
 * {@code ZanderApiClient#getMapTokens} / {@code #requestMapToken} for the
 * balance read/spend path used by the in-game menu.
 */
public class MapTokenService {

    private final Plugin plugin;
    private final ZanderPGMConfig config;
    private final ZanderApiClient api;
    private final ZanderWebSocketClient ws;
    private final MapRotationService rotation;
    private final MapVoteService voteService;
    private final SafeLogger logger;

    private final Map<String, Long> playerCooldowns = new ConcurrentHashMap<>();
    private final Map<String, Integer> mapCooldowns = new ConcurrentHashMap<>();

    public MapTokenService(Plugin plugin, ZanderPGMConfig config, ZanderApiClient api,
                           ZanderWebSocketClient ws, MapRotationService rotation,
                           MapVoteService voteService, SafeLogger logger) {
        this.plugin = plugin;
        this.config = config;
        this.api = api;
        this.ws = ws;
        this.rotation = rotation;
        this.voteService = voteService;
        this.logger = logger;
    }

    /** Process a request end-to-end (validation happens on the main thread). */
    public void handle(MapTokenRequest req) {
        if (!config.mapTokensEnabled || !config.feature("mapTokens")) {
            reject(req, "Map tokens are disabled");
            return;
        }
        emit(req, "MAP_REQUEST_RECEIVED", "RECEIVED", null);

        AsyncUtil.sync(plugin, () -> {
            String failure = validate(req);
            if (failure != null) {
                reject(req, failure);
                return;
            }
            emit(req, "MAP_REQUEST_ACCEPTED", "ACCEPTED", null);
            apply(req);
        });
    }

    private String validate(MapTokenRequest req) {
        if (req.mapKey == null || req.mapKey.isBlank()) {
            return "No map specified";
        }
        if (!rotation.mapExists(req.mapKey)) {
            return "Map does not exist";
        }
        if (Bukkit.getOnlinePlayers().size() < config.mapTokenMinimumPlayersOnline) {
            return "Not enough players online";
        }
        long now = System.currentTimeMillis();
        Long until = playerCooldowns.get(req.uuid);
        if (until != null && until > now) {
            return "Player cooldown active";
        }
        Integer mapCd = mapCooldowns.get(req.mapKey.toLowerCase());
        if (mapCd != null && mapCd > 0) {
            return "Map cooldown active";
        }
        return null;
    }

    private void apply(MapTokenRequest req) {
        try {
            if (req.isSetNext()) {
                rotation.setNextMapOverride(req.mapKey);
            } else if (req.isSponsor()) {
                voteService.addNomination(req.mapKey, req.mapKey, true);
            } else {
                voteService.addNomination(req.mapKey, req.mapKey, false);
            }
            playerCooldowns.put(req.uuid,
                    System.currentTimeMillis() + config.mapTokenPlayerCooldownMinutes * 60_000L);
            mapCooldowns.put(req.mapKey.toLowerCase(), config.mapTokenMapCooldownMatches);
            emit(req, "MAP_REQUEST_APPLIED", "APPLIED", null);
            Bukkit.broadcastMessage("§6[Mixed] §e" + req.username + " used a Map Token for §f" + req.mapKey);
        } catch (Exception e) {
            fail(req, "Apply error: " + e.getMessage());
        }
    }

    private void reject(MapTokenRequest req, String reason) {
        emit(req, "MAP_REQUEST_REJECTED", "REJECTED", reason);
        maybeRefund(req, reason);
    }

    private void fail(MapTokenRequest req, String reason) {
        emit(req, "MAP_REQUEST_FAILED", "FAILED", reason);
        maybeRefund(req, reason);
    }

    private void maybeRefund(MapTokenRequest req, String reason) {
        if (config.mapTokenRefundIfFailed) {
            emit(req, "MAP_REQUEST_REFUNDED", "REFUNDED", reason);
        }
    }

    private void emit(MapTokenRequest req, String type, String status, String reason) {
        MapTokenRequestEventDto dto = new MapTokenRequestEventDto(type);
        dto.requestId = req.id;
        dto.uuid = req.uuid;
        dto.username = req.username;
        dto.mapKey = req.mapKey;
        dto.action = req.action;
        dto.tokenCost = req.tokenCost;
        dto.status = status;
        dto.reason = reason;
        if (api != null) {
            api.send(dto);
        }
        if (ws != null) {
            ws.send(dto);
        }
        if (req.id != null && api != null) {
            Map<String, Object> result = new HashMap<>();
            result.put("status", status);
            result.put("reason", reason);
            api.mapTokenResult(req.id, result);
        }
    }

    /** Decrement per-map cooldown counters when a match ends. */
    public void tickMatchCooldowns() {
        mapCooldowns.replaceAll((k, v) -> Math.max(0, v - 1));
        mapCooldowns.values().removeIf(v -> v <= 0);
    }

    public int pendingCount() {
        return 0;
    }

    public String status() {
        return "enabled=" + config.mapTokensEnabled
                + ", nextMapOverride=" + rotation.nextMapOverride().orElse("none")
                + ", playerCooldowns=" + playerCooldowns.size()
                + ", mapCooldowns=" + mapCooldowns.size();
    }

    public synchronized boolean clearOverride(String actor, String source) {
        boolean hadOverride = rotation.nextMapOverride().isPresent();
        rotation.clearNextMapOverride();
        if (hadOverride) {
            MapTokensBalanceEventDto dto = new MapTokensBalanceEventDto("MAP_TOKEN_OVERRIDE_CLEARED");
            dto.reason = "Pending next-map override cleared";
            dto.actor = actor;
            dto.source = source;
            dto.createdAt = TimeUtil.isoNow();
            if (api != null) {
                api.send(dto);
            }
            if (ws != null) {
                ws.send(dto);
            }
        }
        return hadOverride;
    }
}