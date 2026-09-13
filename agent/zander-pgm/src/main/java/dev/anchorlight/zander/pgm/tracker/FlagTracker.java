package dev.anchorlight.zander.pgm.tracker;

import dev.anchorlight.zander.pgm.stats.PlayerStats;

/** Flag objective: pickup, drop, capture, recover, defend, carrier changes. */
public class FlagTracker {
    public static final String TYPE = "FLAG";

    public void apply(PlayerStats stats, String action) {
        if (stats == null || action == null) return;
        switch (action.toUpperCase()) {
            case "CAPTURE" -> {
                stats.flagCaptures++;
                stats.objectivesCaptured++;
            }
            case "DEFEND", "RECOVER" -> stats.objectivesDefended++;
            default -> { /* pickup/drop/carrier-change are informational */ }
        }
    }
}
