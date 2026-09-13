package dev.anchorlight.zander.pgm.stats;

import java.util.ArrayList;
import java.util.List;

/** Aggregate statistics for a single match. */
public class MatchStats {
    public String matchId;
    public String mapKey;
    public String mapName;
    public long startedAt;
    public long endedAt;
    public long durationSeconds;
    public List<String> winnerTeams = new ArrayList<>();
    public int participantCount;
    public int totalKills;
    public int totalDeaths;
    public int totalObjectives;
    public List<PlayerStats> playerStats = new ArrayList<>();
}
