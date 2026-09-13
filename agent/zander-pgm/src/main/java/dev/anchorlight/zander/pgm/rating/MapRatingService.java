package dev.anchorlight.zander.pgm.rating;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;
import dev.anchorlight.zander.pgm.api.ZanderApiClient;
import dev.anchorlight.zander.pgm.api.ZanderWebSocketClient;
import dev.anchorlight.zander.pgm.api.dto.MapRatingPromptedEventDto;
import dev.anchorlight.zander.pgm.api.dto.MapRatingSubmittedEventDto;
import dev.anchorlight.zander.pgm.config.ZanderPGMConfig;
import dev.anchorlight.zander.pgm.util.SafeLogger;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Post-match map ratings and optional feedback. On match finish a rating session
 * is opened for the participants; ratings are accepted for a configurable window,
 * may be updated during it, and are reported to zander-web.
 */
public class MapRatingService {

    private final Plugin plugin;
    private final ZanderPGMConfig config;
    private final ZanderApiClient api;
    private final ZanderWebSocketClient ws;
    private final SafeLogger logger;

    private final AtomicReference<MapRatingSession> current = new AtomicReference<>();

    public MapRatingService(Plugin plugin, ZanderPGMConfig config, ZanderApiClient api,
                            ZanderWebSocketClient ws, SafeLogger logger) {
        this.plugin = plugin;
        this.config = config;
        this.api = api;
        this.ws = ws;
        this.logger = logger;
    }

    public MapRatingSession current() {
        return current.get();
    }

    /** Open a rating window for a finished match and prompt its participants. */
    public void openSession(String matchId, String mapKey, String mapName, Set<UUID> participants) {
        if (!config.mapRatingsEnabled || !config.feature("mapRatings") || !config.promptAfterMatch) {
            return;
        }
        MapRatingSession session = new MapRatingSession(matchId, mapKey, mapName, participants,
                config.ratingWindowSeconds);
        current.set(session);
        promptParticipants(session);
        emitPrompt(session);

        Bukkit.getScheduler().runTaskLater(plugin, () -> {
            current.compareAndSet(session, null);
        }, config.ratingWindowSeconds * 20L);
    }

    private void promptParticipants(MapRatingSession session) {
        for (UUID uuid : session.participants) {
            Player p = Bukkit.getPlayer(uuid);
            if (p != null) {
                p.sendMessage("§6§lMatch finished!");
                p.sendMessage("§eHow did you like §f" + session.mapName + "§e?");
                p.sendMessage("§71 = Terrible  2 = Bad  3 = Okay  4 = Good  5 = Excellent");
                p.sendMessage("§aUse §f/maprate <1-5> §aor §f/maprate <1-5> <feedback>");
            }
        }
    }

    /** Result of a submission attempt. */
    public enum Result {OK, UPDATED, NO_SESSION, WINDOW_CLOSED, NOT_PARTICIPANT, INVALID_RATING, NOT_RATED_YET}

    public Result submit(Player player, int rating, String feedback) {
        MapRatingSession session = current.get();
        if (session == null) {
            return Result.NO_SESSION;
        }
        if (!session.isOpen()) {
            return Result.WINDOW_CLOSED;
        }
        if (config.requirePlayedMatch && !session.participated(player.getUniqueId())) {
            return Result.NOT_PARTICIPANT;
        }
        if (rating < 1 || rating > 5) {
            return Result.INVALID_RATING;
        }
        boolean update = session.hasRated(player.getUniqueId());
        if (update && !config.allowRatingUpdatesDuringWindow) {
            return Result.OK; // silently ignore updates when disabled
        }
        String trimmed = sanitizeFeedback(feedback);
        MapRatingSubmission submission = new MapRatingSubmission(player.getUniqueId(), player.getName(), rating, trimmed);
        session.submit(submission);
        emitSubmission(session, submission, update);
        return update ? Result.UPDATED : Result.OK;
    }

    /** Attach feedback only; requires the player already rated (or is eligible). */
    public Result submitFeedbackOnly(Player player, String feedback) {
        MapRatingSession session = current.get();
        if (session == null) {
            return Result.NO_SESSION;
        }
        if (!session.isOpen()) {
            return Result.WINDOW_CLOSED;
        }
        MapRatingSubmission existing = session.get(player.getUniqueId());
        if (existing == null) {
            return Result.NOT_RATED_YET;
        }
        existing.feedback = sanitizeFeedback(feedback);
        existing.timestamp = System.currentTimeMillis();
        emitSubmission(session, existing, true);
        return Result.UPDATED;
    }

    private String sanitizeFeedback(String feedback) {
        if (feedback == null || !config.allowFeedback) {
            return null;
        }
        String t = feedback.trim();
        if (t.isEmpty()) {
            return null;
        }
        return t.length() > config.feedbackMaxLength ? t.substring(0, config.feedbackMaxLength) : t;
    }

    private void emitPrompt(MapRatingSession session) {
        MapRatingPromptedEventDto dto = new MapRatingPromptedEventDto();
        dto.matchId = session.matchId;
        dto.mapKey = session.mapKey;
        dto.mapName = session.mapName;
        dto.ratingWindowSeconds = session.windowSeconds;
        List<String> participants = new ArrayList<>();
        session.participants.forEach(u -> participants.add(u.toString()));
        dto.participants = participants;
        api.send(dto);
        ws.send(dto);
    }

    private void emitSubmission(MapRatingSession session, MapRatingSubmission sub, boolean updated) {
        MapRatingSubmittedEventDto dto = new MapRatingSubmittedEventDto();
        dto.matchId = session.matchId;
        dto.mapKey = session.mapKey;
        dto.mapName = session.mapName;
        dto.uuid = sub.uuid.toString();
        dto.username = sub.username;
        dto.rating = sub.rating;
        dto.feedback = sub.feedback;
        dto.updated = updated;
        api.send(dto);
        ws.send(dto);
        api.submitRating(session.mapKey, dto);
    }

    public void reset() {
        current.set(null);
    }
}
