package dev.anchorlight.zander.pgm.tracker;

import dev.anchorlight.zander.pgm.stats.PlayerStats;

import java.util.Arrays;
import java.util.List;

/**
 * Tracks kill streaks and reports milestone crossings. Stateless beyond the
 * milestone list; per-player streak counts live on {@link PlayerStats}.
 */
public class KillstreakTracker {

    public static final List<Integer> MILESTONES = Arrays.asList(3, 5, 10, 15, 20);

    /** Record a kill; returns the milestone reached, or -1 if none. */
    public int onKill(PlayerStats stats) {
        stats.currentKillstreak++;
        if (stats.currentKillstreak > stats.bestKillstreak) {
            stats.bestKillstreak = stats.currentKillstreak;
        }
        return MILESTONES.contains(stats.currentKillstreak) ? stats.currentKillstreak : -1;
    }

    /** Reset the current streak on death. */
    public void onDeath(PlayerStats stats) {
        stats.currentKillstreak = 0;
    }
}
