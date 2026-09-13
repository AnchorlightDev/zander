package dev.anchorlight.zander.pgm.tracker;

import dev.anchorlight.zander.pgm.stats.PlayerStats;

/** Core objective: leak, touch, completion/destruction. */
public class CoreTracker {
    public static final String TYPE = "CORE";

    public void apply(PlayerStats stats, String action) {
        if (stats == null || action == null) return;
        switch (action.toUpperCase()) {
            case "LEAK", "COMPLETE", "DESTROY" -> {
                stats.coreLeaks++;
                stats.objectivesCaptured++;
            }
            case "TOUCH" -> { /* informational */ }
            default -> { }
        }
    }
}
