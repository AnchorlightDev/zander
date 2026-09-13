package dev.anchorlight.zander.pgm.rating;

import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** Post-match rating window for one match/map. */
public class MapRatingSession {

    public final String matchId;
    public final String mapKey;
    public final String mapName;
    public final Set<UUID> participants;
    public final long startedAt;
    public final int windowSeconds;

    private final Map<UUID, MapRatingSubmission> submissions = new ConcurrentHashMap<>();

    public MapRatingSession(String matchId, String mapKey, String mapName,
                            Set<UUID> participants, int windowSeconds) {
        this.matchId = matchId;
        this.mapKey = mapKey;
        this.mapName = mapName;
        this.participants = participants;
        this.windowSeconds = windowSeconds;
        this.startedAt = System.currentTimeMillis();
    }

    public boolean isOpen() {
        return System.currentTimeMillis() - startedAt < windowSeconds * 1000L;
    }

    public boolean participated(UUID uuid) {
        return participants.contains(uuid);
    }

    public boolean hasRated(UUID uuid) {
        return submissions.containsKey(uuid);
    }

    public MapRatingSubmission get(UUID uuid) {
        return submissions.get(uuid);
    }

    public void submit(MapRatingSubmission submission) {
        submissions.put(submission.uuid, submission);
    }

    public int count() {
        return submissions.size();
    }
}
