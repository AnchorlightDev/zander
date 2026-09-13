package dev.anchorlight.zander.pgm.tracker;

import dev.anchorlight.zander.pgm.stats.PlayerStats;

/** Control point objective: capture progress, owner change, contested state. */
public class ControlPointTracker {
    public static final String TYPE = "CONTROL_POINT";

    public void apply(PlayerStats stats, String action) {
        if (stats == null || action == null) return;
        switch (action.toUpperCase()) {
            case "CAPTURE", "OWNER_CHANGE" -> {
                stats.controlPointCaptures++;
                stats.objectivesCaptured++;
            }
            case "DEFEND" -> stats.objectivesDefended++;
            default -> { /* progress/contested are informational */ }
        }
    }
}
