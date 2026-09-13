package dev.anchorlight.zander.pgm.api.dto;

import dev.anchorlight.zander.pgm.stats.MapStats;

public class MapStatsSnapshotDto extends BridgeEvent {
    public MapStats stats;

    public MapStatsSnapshotDto() {
        super("MAP_STATS_SNAPSHOT");
    }

    public MapStatsSnapshotDto(MapStats stats) {
        this();
        this.stats = stats;
    }
}
