package dev.anchorlight.zander.pgm.progression;

import dev.anchorlight.zander.pgm.stats.PlayerStats;

import java.util.function.Predicate;

/**
 * A single achievement. Definitions are pure data plus a predicate over a
 * player's live stats, making new achievements trivial to add.
 */
public class AchievementDefinition {

    public final String id;
    public final String name;
    public final String description;
    private final Predicate<PlayerStats> condition;

    public AchievementDefinition(String id, String name, String description, Predicate<PlayerStats> condition) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.condition = condition;
    }

    public boolean isSatisfied(PlayerStats stats) {
        try {
            return condition.test(stats);
        } catch (Exception e) {
            return false;
        }
    }
}
