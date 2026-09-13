package dev.anchorlight.zander.pgm.progression;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/** Tracks which achievements a player has already unlocked this session. */
public class AchievementProgress {

    public final UUID uuid;
    public final Set<String> unlocked = new HashSet<>();

    public AchievementProgress(UUID uuid) {
        this.uuid = uuid;
    }

    public boolean hasUnlocked(String achievementId) {
        return unlocked.contains(achievementId);
    }

    public boolean unlock(String achievementId) {
        return unlocked.add(achievementId);
    }
}
