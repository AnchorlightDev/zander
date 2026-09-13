package dev.anchorlight.zander.pgm.stats;

import java.util.HashMap;
import java.util.Map;

/** Rolling aggregate statistics for a map, keyed by map key. */
public class MapStats {
    public String mapKey;
    public String mapName;
    public String mapVersion;
    public int timesPlayed;
    public double averageDuration;
    public Map<String, Double> teamWinRates = new HashMap<>();
    public long totalKills;
    public long totalObjectives;
    public long lastPlayedAt;

    // Internal running totals used to compute averages.
    public transient long totalDurationSeconds;
    public final transient Map<String, Integer> teamWins = new HashMap<>();

    public MapStats() {
    }

    public MapStats(String mapKey, String mapName) {
        this.mapKey = mapKey;
        this.mapName = mapName;
    }

    public void recordMatch(long durationSeconds, java.util.List<String> winners) {
        timesPlayed++;
        totalDurationSeconds += durationSeconds;
        averageDuration = (double) totalDurationSeconds / timesPlayed;
        lastPlayedAt = System.currentTimeMillis();
        if (winners != null) {
            for (String team : winners) {
                teamWins.merge(team, 1, Integer::sum);
            }
        }
        for (Map.Entry<String, Integer> e : teamWins.entrySet()) {
            teamWinRates.put(e.getKey(), (double) e.getValue() / timesPlayed);
        }
    }
}
