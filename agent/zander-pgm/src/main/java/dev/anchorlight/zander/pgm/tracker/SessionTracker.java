package dev.anchorlight.zander.pgm.tracker;

import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.api.dto.PlayerJoinMatchEventDto;
import dev.anchorlight.zander.pgm.api.dto.PlayerLeaveMatchEventDto;
import dev.anchorlight.zander.pgm.pgm.MatchIdentityService;
import dev.anchorlight.zander.pgm.stats.PlayerStats;

import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tracks per-player session time and emits join/leave match events.
 * Accumulates {@link PlayerStats#playtimeSeconds} on quit.
 */
public class SessionTracker implements Listener {

    private final ZanderPGMPlugin plugin;
    private final ConcurrentHashMap<UUID, Long> joinTimes = new ConcurrentHashMap<>();

    public SessionTracker(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        Player p = event.getPlayer();
        joinTimes.put(p.getUniqueId(), System.currentTimeMillis());

        MatchIdentityService.Identity id = plugin.identity().current();
        PlayerJoinMatchEventDto dto = new PlayerJoinMatchEventDto();
        dto.matchId = id != null ? id.matchId : null;
        dto.uuid = p.getUniqueId().toString();
        dto.username = p.getName();
        plugin.api().send(dto);
        plugin.ws().send(dto);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        Player p = event.getPlayer();
        Long joined = joinTimes.remove(p.getUniqueId());
        long sessionSeconds = 0;
        if (joined != null) {
            sessionSeconds = (System.currentTimeMillis() - joined) / 1000L;
            if (plugin.cfg().includeSessionStats) {
                PlayerStats stats = plugin.stats().peek(p.getUniqueId());
                if (stats != null) {
                    stats.playtimeSeconds += sessionSeconds;
                }
            }
        }
        MatchIdentityService.Identity id = plugin.identity().current();
        PlayerLeaveMatchEventDto dto = new PlayerLeaveMatchEventDto();
        dto.matchId = id != null ? id.matchId : null;
        dto.uuid = p.getUniqueId().toString();
        dto.username = p.getName();
        dto.sessionSeconds = sessionSeconds;
        plugin.api().send(dto);
        plugin.ws().send(dto);
    }
}
