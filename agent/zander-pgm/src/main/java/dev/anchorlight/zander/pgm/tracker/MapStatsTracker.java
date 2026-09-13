package dev.anchorlight.zander.pgm.tracker;

import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.pgm.MatchIdentityService;
import dev.anchorlight.zander.pgm.stats.MapStats;
import dev.anchorlight.zander.pgm.stats.PlayerStats;

import java.util.List;

/** Rolls per-match results into the persistent {@link MapStats} accumulator. */
public class MapStatsTracker {

    private final ZanderPGMPlugin plugin;

    public MapStatsTracker(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    public MapStats recordMatch(MatchIdentityService.Identity id, long durationSeconds, List<String> winners) {
        MapStats stats = plugin.stats().map(id.mapKey, id.mapName);
        stats.mapVersion = id.mapVersion;
        long kills = 0;
        long objectives = 0;
        for (PlayerStats p : plugin.stats().allPlayers()) {
            kills += p.kills;
            objectives += p.objectivesCaptured;
        }
        stats.totalKills += kills;
        stats.totalObjectives += objectives;
        stats.recordMatch(durationSeconds, winners);
        return stats;
    }
}
