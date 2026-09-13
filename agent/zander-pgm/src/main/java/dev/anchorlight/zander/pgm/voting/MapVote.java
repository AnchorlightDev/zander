package dev.anchorlight.zander.pgm.voting;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** State of a single map vote: its options, casts, and tally. */
public class MapVote {

    public final String voteId;
    public final List<MapVoteOption> options;
    public final long startedAt;
    public final int durationSeconds;
    public volatile boolean active = true;

    private final Map<UUID, MapVoteCast> casts = new LinkedHashMap<>();

    public MapVote(String voteId, List<MapVoteOption> options, int durationSeconds) {
        this.voteId = voteId;
        this.options = options;
        this.durationSeconds = durationSeconds;
        this.startedAt = System.currentTimeMillis();
    }

    public MapVoteOption option(int number) {
        return options.stream().filter(o -> o.number == number).findFirst().orElse(null);
    }

    /** Record or update a player's cast (players may change their vote). */
    public synchronized void cast(MapVoteCast cast) {
        casts.put(cast.uuid, cast);
    }

    public synchronized boolean hasVoted(UUID uuid) {
        return casts.containsKey(uuid);
    }

    /** Weighted tally keyed by option number, including token boosts. */
    public synchronized Map<Integer, Integer> tally() {
        Map<Integer, Integer> result = new LinkedHashMap<>();
        for (MapVoteOption o : options) {
            result.put(o.number, o.boostWeight);
        }
        for (MapVoteCast c : casts.values()) {
            result.merge(c.optionNumber, c.weight, Integer::sum);
        }
        return result;
    }

    public synchronized MapVoteOption winner() {
        Map<Integer, Integer> tally = tally();
        int bestNumber = -1;
        int bestScore = Integer.MIN_VALUE;
        for (Map.Entry<Integer, Integer> e : tally.entrySet()) {
            if (e.getValue() > bestScore) {
                bestScore = e.getValue();
                bestNumber = e.getKey();
            }
        }
        return option(bestNumber);
    }

    public boolean isExpired() {
        return System.currentTimeMillis() - startedAt >= durationSeconds * 1000L;
    }
}
