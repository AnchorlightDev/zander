package dev.anchorlight.zander.pgm.stats;

import dev.anchorlight.zander.pgm.api.ZanderApiClient;
import dev.anchorlight.zander.pgm.api.dto.MapStatsSnapshotDto;
import dev.anchorlight.zander.pgm.api.dto.MatchStatsSnapshotDto;
import dev.anchorlight.zander.pgm.api.dto.PlayerStatsSnapshotDto;

/** Serialises accumulated stats into snapshot DTOs and ships them to zander-web. */
public class StatsSnapshotService {

    private final StatsAccumulator accumulator;
    private final ZanderApiClient api;

    public StatsSnapshotService(StatsAccumulator accumulator, ZanderApiClient api) {
        this.accumulator = accumulator;
        this.api = api;
    }

    /** Periodic flush of live player stats (called by the snapshot task). */
    public void flushPlayerStats(String matchId) {
        for (PlayerStats stats : accumulator.allPlayers()) {
            stats.recomputeBowAccuracy();
            api.statsPlayer(new PlayerStatsSnapshotDto(matchId, stats));
        }
    }

    public void sendPlayerSnapshot(String matchId, PlayerStats stats) {
        stats.recomputeBowAccuracy();
        api.send(new PlayerStatsSnapshotDto(matchId, stats));
    }

    public void sendMatchSnapshot(MatchStats stats) {
        api.send(new MatchStatsSnapshotDto(stats));
        api.statsMatch(new MatchStatsSnapshotDto(stats));
    }

    public void sendMapSnapshot(MapStats stats) {
        api.send(new MapStatsSnapshotDto(stats));
        api.statsMap(new MapStatsSnapshotDto(stats));
    }
}
