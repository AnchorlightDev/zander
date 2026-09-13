package dev.anchorlight.zander.pgm.voting;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;
import org.bukkit.scheduler.BukkitTask;
import dev.anchorlight.zander.pgm.api.ZanderApiClient;
import dev.anchorlight.zander.pgm.api.ZanderWebSocketClient;
import dev.anchorlight.zander.pgm.api.dto.MapVoteCancelledEventDto;
import dev.anchorlight.zander.pgm.api.dto.MapVoteCastEventDto;
import dev.anchorlight.zander.pgm.api.dto.MapVoteEndedEventDto;
import dev.anchorlight.zander.pgm.api.dto.MapVoteStartedEventDto;
import dev.anchorlight.zander.pgm.config.ZanderPGMConfig;
import dev.anchorlight.zander.pgm.pgm.MapRotationService;
import dev.anchorlight.zander.pgm.util.SafeLogger;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Runs Mixed map voting. Votes always apply to the NEXT match and never
 * interrupt a running one. Supports in-game and (via zander-web) web voting,
 * token nominations and token boosts, with a configurable window and options.
 */
public class MapVoteService {

    private final Plugin plugin;
    private final ZanderPGMConfig config;
    private final ZanderApiClient api;
    private final ZanderWebSocketClient ws;
    private final MapRotationService rotation;
    private final SafeLogger logger;

    private final AtomicReference<MapVote> current = new AtomicReference<>();
    private final List<MapVoteOption> pendingNominations = Collections.synchronizedList(new ArrayList<>());
    private BukkitTask endTask;

    public MapVoteService(Plugin plugin, ZanderPGMConfig config, ZanderApiClient api,
                          ZanderWebSocketClient ws, MapRotationService rotation,
                          SafeLogger logger) {
        this.plugin = plugin;
        this.config = config;
        this.api = api;
        this.ws = ws;
        this.rotation = rotation;
        this.logger = logger;
    }

    public MapVote current() {
        return current.get();
    }

    public boolean isActive() {
        MapVote v = current.get();
        return v != null && v.active;
    }

    /** Add a token-nominated option to the next vote's pool. */
    public void addNomination(String mapKey, String mapName, boolean sponsored) {
        pendingNominations.add(new MapVoteOption(0, mapKey, mapName,
                sponsored ? "TOKEN_SPONSOR" : "TOKEN_NOMINATION"));
    }

    /** Build a set of options: nominations first, then rotation/random fill. */
    private List<MapVoteOption> buildOptions() {
        List<MapVoteOption> options = new ArrayList<>();
        int number = 1;
        synchronized (pendingNominations) {
            for (MapVoteOption nom : pendingNominations) {
                if (number > config.optionsPerVote) break;
                MapVoteOption o = new MapVoteOption(number++, nom.mapKey, nom.mapName, nom.source);
                if (config.allowTokenBoosts && "TOKEN_SPONSOR".equals(nom.source)) {
                    o.boostWeight = config.tokenBoostWeight;
                }
                options.add(o);
            }
            pendingNominations.clear();
        }
        List<String> maps = new ArrayList<>(rotation.availableMapNames());
        Collections.shuffle(maps);
        for (String map : maps) {
            if (number > config.optionsPerVote) break;
            boolean dup = options.stream().anyMatch(o -> o.mapName.equalsIgnoreCase(map));
            if (!dup) {
                options.add(new MapVoteOption(number++, map, map, "RANDOM"));
            }
        }
        return options;
    }

    public MapVote start() {
        if (!config.mapVotingEnabled || !config.feature("mapVoting")) {
            return null;
        }
        if (isActive()) {
            return current.get();
        }
        List<MapVoteOption> options = buildOptions();
        if (options.isEmpty()) {
            logger.debug("No eligible maps for voting");
            return null;
        }
        MapVote vote = new MapVote(UUID.randomUUID().toString(), options, config.voteDurationSeconds);
        current.set(vote);
        announceStart(vote);
        emitStart(vote);

        endTask = Bukkit.getScheduler().runTaskLater(plugin, this::end, vote.durationSeconds * 20L);
        return vote;
    }

    private void announceStart(MapVote vote) {
        Bukkit.broadcastMessage("§6[Mixed] §eVote for the next map! §7(/vote <number>)");
        for (MapVoteOption o : vote.options) {
            Bukkit.broadcastMessage("  §b" + o.number + ") §f" + o.mapName
                    + (o.boostWeight > 0 ? " §d★" : ""));
        }
    }

    /** Cast an in-game vote; players may change their vote while active. */
    public boolean cast(Player player, int number) {
        MapVote vote = current.get();
        if (vote == null || !vote.active) {
            player.sendMessage("§cThere is no active map vote.");
            return false;
        }
        MapVoteOption option = vote.option(number);
        if (option == null) {
            player.sendMessage("§cInvalid option: " + number);
            return false;
        }
        vote.cast(new MapVoteCast(player.getUniqueId(), player.getName(), number, 1, "IN_GAME"));
        player.sendMessage("§aVote recorded for §f" + option.mapName);

        MapVoteCastEventDto dto = new MapVoteCastEventDto();
        dto.voteId = vote.voteId;
        dto.uuid = player.getUniqueId().toString();
        dto.username = player.getName();
        dto.mapKey = option.mapKey;
        dto.weight = 1;
        dto.source = "IN_GAME";
        api.send(dto);
        api.castVote(dto);
        ws.send(dto);
        return true;
    }

    public MapVoteOption end() {
        MapVote vote = current.getAndSet(null);
        if (vote == null) {
            return null;
        }
        vote.active = false;
        cancelTask();
        MapVoteOption winner = vote.winner();
        if (winner != null && config.applyWinnerToNextMatch) {
            rotation.setNextMapOverride(winner.mapKey);
            Bukkit.broadcastMessage("§6[Mixed] §eNext map: §f" + winner.mapName);
        }
        emitEnd(vote, winner);
        return winner;
    }

    public void cancel(String reason) {
        MapVote vote = current.getAndSet(null);
        if (vote == null) {
            return;
        }
        vote.active = false;
        cancelTask();
        MapVoteCancelledEventDto dto = new MapVoteCancelledEventDto();
        dto.voteId = vote.voteId;
        dto.reason = reason;
        api.send(dto);
        ws.send(dto);
        Bukkit.broadcastMessage("§6[Mixed] §cMap vote cancelled.");
    }

    private void cancelTask() {
        if (endTask != null) {
            endTask.cancel();
            endTask = null;
        }
    }

    private void emitStart(MapVote vote) {
        MapVoteStartedEventDto dto = new MapVoteStartedEventDto();
        dto.voteId = vote.voteId;
        dto.durationSeconds = vote.durationSeconds;
        dto.options = new ArrayList<>();
        for (MapVoteOption o : vote.options) {
            Map<String, Object> m = new HashMap<>();
            m.put("number", o.number);
            m.put("mapKey", o.mapKey);
            m.put("mapName", o.mapName);
            m.put("source", o.source);
            m.put("boostWeight", o.boostWeight);
            dto.options.add(m);
        }
        api.send(dto);
        ws.send(dto);
    }

    private void emitEnd(MapVote vote, MapVoteOption winner) {
        MapVoteEndedEventDto dto = new MapVoteEndedEventDto();
        dto.voteId = vote.voteId;
        if (winner != null) {
            dto.winningMapKey = winner.mapKey;
            dto.winningMapName = winner.mapName;
        }
        Map<String, Integer> tally = new HashMap<>();
        vote.tally().forEach((num, score) -> {
            MapVoteOption o = vote.option(num);
            tally.put(o != null ? o.mapName : String.valueOf(num), score);
        });
        dto.tally = tally;
        api.send(dto);
        ws.send(dto);
    }
}
