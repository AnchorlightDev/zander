package dev.anchorlight.zander.pgm.stats;

import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Lightweight, in-memory leaderboard views over the current stats. Persistent,
 * cross-session leaderboards live in zander-web; this serves in-game queries.
 */
public class LeaderboardService {

    private final StatsAccumulator accumulator;

    public LeaderboardService(StatsAccumulator accumulator) {
        this.accumulator = accumulator;
    }

    public List<PlayerStats> topBy(Comparator<PlayerStats> comparator, int limit) {
        return accumulator.allPlayers().stream()
                .sorted(comparator.reversed())
                .limit(limit)
                .collect(Collectors.toList());
    }

    public List<PlayerStats> topKills(int limit) {
        return topBy(Comparator.comparingInt(p -> p.kills), limit);
    }

    public List<PlayerStats> topObjectives(int limit) {
        return topBy(Comparator.comparingInt(p -> p.objectivesCaptured), limit);
    }
}
