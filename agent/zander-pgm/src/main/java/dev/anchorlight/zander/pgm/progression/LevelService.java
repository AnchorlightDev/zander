package dev.anchorlight.zander.pgm.progression;

/** Level curve for v0.1.0: {@code level = floor(sqrt(totalXp / 100)) + 1}. */
public class LevelService {

    public int levelForXp(long totalXp) {
        if (totalXp <= 0) {
            return 1;
        }
        return (int) Math.floor(Math.sqrt(totalXp / 100.0)) + 1;
    }

    /** Total XP required to reach the given level. */
    public long xpForLevel(int level) {
        long l = Math.max(1, level) - 1L;
        return l * l * 100L;
    }
}
