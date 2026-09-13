package dev.anchorlight.zander.pgm.stats;

import java.util.Collection;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Central in-memory store of live statistics. Per-player stats are reset each
 * match; map stats accumulate across the server lifetime. Backed by concurrent
 * maps so trackers on the main thread and snapshot tasks can read safely.
 */
public class StatsAccumulator {

    private final ConcurrentHashMap<UUID, PlayerStats> players = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, MapStats> maps = new ConcurrentHashMap<>();

    public PlayerStats player(UUID uuid, String username) {
        return players.compute(uuid, (id, existing) -> {
            if (existing == null) {
                return new PlayerStats(id, username);
            }
            if (username != null) {
                existing.username = username;
            }
            return existing;
        });
    }

    public PlayerStats peek(UUID uuid) {
        return players.get(uuid);
    }

    public Collection<PlayerStats> allPlayers() {
        return players.values();
    }

    public MapStats map(String mapKey, String mapName) {
        return maps.computeIfAbsent(mapKey, k -> new MapStats(mapKey, mapName));
    }

    public MapStats peekMap(String mapKey) {
        return maps.get(mapKey);
    }

    public Collection<MapStats> allMaps() {
        return maps.values();
    }

    /** Reset per-player match stats at the start of a new match. */
    public void resetForNewMatch() {
        players.clear();
    }
}
