package dev.anchorlight.zander.pgm.api.dto;

import dev.anchorlight.zander.pgm.stats.PlayerStats;

public class PlayerStatsSnapshotDto extends BridgeEvent {
    public String matchId;
    public PlayerStats stats;

    public PlayerStatsSnapshotDto() {
        super("PLAYER_STATS_SNAPSHOT");
    }

    public PlayerStatsSnapshotDto(String matchId, PlayerStats stats) {
        this();
        this.matchId = matchId;
        this.stats = stats;
    }
}
