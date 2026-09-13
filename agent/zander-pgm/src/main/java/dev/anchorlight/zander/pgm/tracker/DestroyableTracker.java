package dev.anchorlight.zander.pgm.tracker;

import dev.anchorlight.zander.pgm.stats.PlayerStats;

/** Destroyable (monument) objective: damage contribution and destruction. */
public class DestroyableTracker {
    public static final String TYPE = "DESTROYABLE";

    public void apply(PlayerStats stats, String action, double amount) {
        if (stats == null || action == null) return;
        switch (action.toUpperCase()) {
            case "DAMAGE", "HEALTH_CHANGE" -> stats.destroyableDamage += Math.max(0, amount);
            case "DESTROY", "DESTROYED" -> {
                stats.objectivesCaptured++;
            }
            default -> { }
        }
    }
}
