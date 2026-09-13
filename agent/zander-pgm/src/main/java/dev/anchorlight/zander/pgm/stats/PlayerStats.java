package dev.anchorlight.zander.pgm.stats;

import java.util.UUID;

/** Accumulated per-player statistics. Mutated on the main thread. */
public class PlayerStats {
    public String uuid;
    public String username;

    public int matchesPlayed;
    public int wins;
    public int losses;
    public int kills;
    public int deaths;
    public int assists;
    public int firstBloods;
    public int currentKillstreak;
    public int bestKillstreak;

    public double damageDealt;
    public double damageTaken;
    public int bowShots;
    public int bowHits;
    public double bowAccuracy;

    public int objectivesCaptured;
    public int objectivesDefended;
    public int woolCaptures;
    public int flagCaptures;
    public int coreLeaks;
    public double destroyableDamage;
    public int controlPointCaptures;

    public int blocksBroken;
    public int blocksPlaced;

    public long playtimeSeconds;
    public long xpEarned;
    public int level = 1;
    public int achievementsUnlocked;

    public PlayerStats() {
    }

    public PlayerStats(UUID uuid, String username) {
        this.uuid = uuid.toString();
        this.username = username;
    }

    public void recomputeBowAccuracy() {
        this.bowAccuracy = bowShots == 0 ? 0.0 : (double) bowHits / bowShots;
    }
}
