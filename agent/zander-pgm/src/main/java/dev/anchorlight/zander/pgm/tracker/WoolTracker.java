package dev.anchorlight.zander.pgm.tracker;

import dev.anchorlight.zander.pgm.stats.PlayerStats;

/** Wool objective: pickup, drop, place/capture, defend, recover. */
public class WoolTracker {
    public static final String TYPE = "WOOL";

    public void apply(PlayerStats stats, String action) {
        if (stats == null || action == null) return;
        switch (action.toUpperCase()) {
            case "PLACE", "CAPTURE" -> {
                stats.woolCaptures++;
                stats.objectivesCaptured++;
            }
            case "DEFEND", "RECOVER" -> stats.objectivesDefended++;
            default -> { /* pickup/drop are informational */ }
        }
    }
}
