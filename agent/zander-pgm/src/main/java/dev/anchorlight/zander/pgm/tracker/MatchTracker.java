package dev.anchorlight.zander.pgm.tracker;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.api.dto.MatchEndedEvent;
import dev.anchorlight.zander.pgm.api.dto.MatchLoadedEvent;
import dev.anchorlight.zander.pgm.api.dto.MatchStartedEvent;
import dev.anchorlight.zander.pgm.pgm.MatchIdentityService;
import dev.anchorlight.zander.pgm.pgm.PGMHook;
import dev.anchorlight.zander.pgm.pgm.PGMUtils;
import dev.anchorlight.zander.pgm.progression.XpService;
import dev.anchorlight.zander.pgm.stats.MapStats;
import dev.anchorlight.zander.pgm.stats.MatchStats;
import dev.anchorlight.zander.pgm.stats.PlayerStats;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Owns the PGM match lifecycle: emits MATCH_LOADED / MATCH_STARTED / MATCH_ENDED,
 * produces end-of-match stat snapshots, opens the post-match rating window, and
 * ticks map/token cooldowns. All PGM reads run on the main thread (event thread).
 */
public class MatchTracker implements PGMHook.MatchLifecycleListener {

    private final ZanderPGMPlugin plugin;
    private final MapStatsTracker mapStatsTracker;
    private final AtomicBoolean firstBloodTaken = new AtomicBoolean(false);
    private volatile long matchStartMillis;

    public MatchTracker(ZanderPGMPlugin plugin, MapStatsTracker mapStatsTracker) {
        this.plugin = plugin;
        this.mapStatsTracker = mapStatsTracker;
    }

    /** Returns true for the first caller in a match (first blood). */
    public boolean claimFirstBlood() {
        return firstBloodTaken.compareAndSet(false, true);
    }

    @Override
    public void onMatchLoad(Object match) {
        if (!plugin.cfg().feature("matchLifecycle")) {
            plugin.log().debug("onMatchLoad skipped: matchLifecycle feature disabled");
            return;
        }
        MatchIdentityService.Identity id = plugin.identity().update(match);
        Object map = PGMUtils.getMap(match);

        MatchLoadedEvent dto = new MatchLoadedEvent();
        dto.matchId = id.matchId;
        dto.mapKey = id.mapKey;
        dto.mapName = id.mapName;
        dto.mapVersion = id.mapVersion;
        dto.mapAuthors = PGMUtils.mapAuthors(map);
        dto.maxPlayers = Bukkit.getMaxPlayers();
        plugin.log().info("MATCH_LOADED " + id.matchId + " map=" + id.mapName + " (" + id.mapKey + ")");
        plugin.api().send(dto);
        plugin.ws().send(dto);
    }

    @Override
    public void onMatchStart(Object match) {
        if (!plugin.cfg().feature("matchLifecycle")) {
            plugin.log().debug("onMatchStart skipped: matchLifecycle feature disabled");
            return;
        }
        MatchIdentityService.Identity id = plugin.identity().current();
        matchStartMillis = System.currentTimeMillis();
        firstBloodTaken.set(false);
        plugin.stats().resetForNewMatch();

        MatchStartedEvent dto = new MatchStartedEvent();
        if (id != null) {
            dto.matchId = id.matchId;
            dto.mapKey = id.mapKey;
            dto.mapName = id.mapName;
        }
        dto.startedAt = matchStartMillis;
        dto.participants = PGMUtils.participantNames(match);
        plugin.log().info("MATCH_STARTED " + (id != null ? id.matchId : "?")
                + " participants=" + dto.participants.size());
        plugin.api().send(dto);
        plugin.ws().send(dto);
    }

    @Override
    public void onMatchFinish(Object match) {
        if (!plugin.cfg().feature("matchLifecycle")) {
            plugin.log().debug("onMatchFinish skipped: matchLifecycle feature disabled");
            return;
        }
        MatchIdentityService.Identity id = plugin.identity().current();
        long endMillis = System.currentTimeMillis();
        long duration = matchStartMillis > 0 ? (endMillis - matchStartMillis) / 1000L : 0;

        List<String> winners = resolveWinners(match);
        Set<UUID> participants = onlineParticipantUuids();

        awardEndOfMatchXp(winners, id != null ? id.matchId : null);

        MatchEndedEvent ended = new MatchEndedEvent();
        if (id != null) {
            ended.matchId = id.matchId;
            ended.mapKey = id.mapKey;
            ended.mapName = id.mapName;
        }
        ended.endedAt = endMillis;
        ended.durationSeconds = duration;
        ended.winners = winners;
        ended.participants = new ArrayList<>();
        participants.forEach(u -> ended.participants.add(u.toString()));
        plugin.log().info("MATCH_ENDED " + (id != null ? id.matchId : "?")
                + " duration=" + duration + "s winners=" + winners
                + " participants=" + participants.size());
        plugin.api().send(ended);
        plugin.ws().send(ended);

        // Match stats snapshot.
        MatchStats matchStats = buildMatchStats(id, duration, winners);
        plugin.snapshots().sendMatchSnapshot(matchStats);
        int playerCount = 0;
        for (PlayerStats stats : plugin.stats().allPlayers()) {
            plugin.snapshots().sendPlayerSnapshot(id != null ? id.matchId : null, stats);
            playerCount++;
        }
        plugin.log().info("Sent match/player stat snapshots for " + playerCount + " player(s)");

        // Map stats snapshot.
        if (id != null) {
            MapStats mapStats = mapStatsTracker.recordMatch(id, duration, winners);
            plugin.snapshots().sendMapSnapshot(mapStats);
        } else {
            plugin.log().warn("Skipped map stats snapshot: no current match identity at finish");
        }

        // Post-match ratings + cooldown ticks.
        if (id != null) {
            plugin.ratings().openSession(id.matchId, id.mapKey, id.mapName, participants);
        }
        plugin.tokens().tickMatchCooldowns();
        plugin.identity().clearCurrent();
    }

    private void awardEndOfMatchXp(List<String> winners, String matchId) {
        for (PlayerStats stats : plugin.stats().allPlayers()) {
            boolean won = winners.stream().anyMatch(w -> w.equalsIgnoreCase(stats.username));
            if (won) {
                stats.wins++;
                plugin.xp().award(stats, XpService.Reason.WIN, matchId);
            } else {
                stats.losses++;
                plugin.xp().award(stats, XpService.Reason.LOSS, matchId);
            }
            stats.matchesPlayed++;
            plugin.achievements().evaluate(stats, matchId);
        }
    }

    private MatchStats buildMatchStats(MatchIdentityService.Identity id, long duration, List<String> winners) {
        MatchStats ms = new MatchStats();
        if (id != null) {
            ms.matchId = id.matchId;
            ms.mapKey = id.mapKey;
            ms.mapName = id.mapName;
        }
        ms.startedAt = matchStartMillis;
        ms.endedAt = System.currentTimeMillis();
        ms.durationSeconds = duration;
        ms.winnerTeams = winners;
        for (PlayerStats stats : plugin.stats().allPlayers()) {
            ms.playerStats.add(stats);
            ms.totalKills += stats.kills;
            ms.totalDeaths += stats.deaths;
            ms.totalObjectives += stats.objectivesCaptured;
        }
        ms.participantCount = ms.playerStats.size();
        return ms;
    }

    @SuppressWarnings("unchecked")
    private List<String> resolveWinners(Object match) {
        List<String> out = new ArrayList<>();
        Object winners = PGMUtils.call(match, "getWinners");
        if (winners instanceof Iterable<?> it) {
            for (Object w : it) {
                String name = PGMUtils.str(w, "getNameLegacy");
                if (name == null) {
                    name = PGMUtils.str(w, "getDefaultName");
                }
                if (name == null) {
                    name = PGMUtils.str(w, "getName");
                }
                if (name != null) {
                    out.add(name);
                }
            }
        }
        return out;
    }

    private Set<UUID> onlineParticipantUuids() {
        Set<UUID> set = new HashSet<>();
        for (Player p : Bukkit.getOnlinePlayers()) {
            set.add(p.getUniqueId());
        }
        return set;
    }

    public long matchStartMillis() {
        return matchStartMillis;
    }
}
