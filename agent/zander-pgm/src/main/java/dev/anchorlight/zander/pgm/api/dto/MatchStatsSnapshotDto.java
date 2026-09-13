package dev.anchorlight.zander.pgm.api.dto;

import dev.anchorlight.zander.pgm.stats.MatchStats;

public class MatchStatsSnapshotDto extends BridgeEvent {
    public MatchStats stats;

    public MatchStatsSnapshotDto() {
        super("MATCH_STATS_SNAPSHOT");
    }

    public MatchStatsSnapshotDto(MatchStats stats) {
        this();
        this.stats = stats;
    }
}
