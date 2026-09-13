package dev.anchorlight.zander.pgm;

import com.google.gson.JsonObject;
import org.bukkit.Bukkit;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;
import dev.anchorlight.stonelib.http.ConnectionHealth;
import dev.anchorlight.stonelib.http.RetryQueue;
import dev.anchorlight.zander.pgm.api.ZanderApiClient;
import dev.anchorlight.zander.pgm.api.ZanderWebSocketClient;
import dev.anchorlight.zander.pgm.api.dto.BridgeEvent;
import dev.anchorlight.zander.pgm.api.dto.ServerHeartbeatEvent;
import dev.anchorlight.zander.pgm.api.dto.ServerOfflineEvent;
import dev.anchorlight.zander.pgm.command.MapFeedbackCommand;
import dev.anchorlight.zander.pgm.command.MapRateCommand;
import dev.anchorlight.zander.pgm.command.MapRatingCommand;
import dev.anchorlight.zander.pgm.command.MapVoteCommand;
import dev.anchorlight.zander.pgm.command.VoteCommand;
import dev.anchorlight.zander.pgm.command.ZpgmCommand;
import dev.anchorlight.zander.pgm.config.ConfigLoader;
import dev.anchorlight.zander.pgm.config.ZanderPGMConfig;
import dev.anchorlight.zander.pgm.pgm.MapRotationService;
import dev.anchorlight.zander.pgm.pgm.MatchIdentityService;
import dev.anchorlight.zander.pgm.pgm.PGMHook;
import dev.anchorlight.zander.pgm.progression.AchievementService;
import dev.anchorlight.zander.pgm.progression.LevelService;
import dev.anchorlight.zander.pgm.progression.XpService;
import dev.anchorlight.zander.pgm.rating.MapRatingService;
import dev.anchorlight.zander.pgm.stats.LeaderboardService;
import dev.anchorlight.zander.pgm.stats.StatsAccumulator;
import dev.anchorlight.zander.pgm.stats.StatsSnapshotService;
import dev.anchorlight.zander.pgm.tokens.MapTokenRequest;
import dev.anchorlight.zander.pgm.tokens.MapTokenRequestPoller;
import dev.anchorlight.zander.pgm.tokens.MapTokenService;
import dev.anchorlight.zander.pgm.tracker.TrackerRegistry;
import dev.anchorlight.zander.pgm.util.JsonUtil;
import dev.anchorlight.zander.pgm.util.SafeLogger;
import dev.anchorlight.zander.pgm.voting.MapVoteService;

import java.util.ArrayList;
import java.util.List;

/**
 * ZanderPGM — PGM companion plugin for the Mixed server. Bridges PGM
 * match/stat/objective events to zander-web over REST and WebSocket, and adds
 * Map Tokens, Map Voting and post-match Map Ratings. Contains no moderation,
 * punishment or chat-tag features by design.
 */
public class ZanderPGMPlugin extends JavaPlugin {

    private SafeLogger log;
    private ZanderPGMConfig config;

    private ConnectionHealth health;
    private RetryQueue<BridgeEvent> queue;
    private ZanderApiClient api;
    private ZanderWebSocketClient ws;

    private StatsAccumulator stats;
    private StatsSnapshotService snapshots;
    private LeaderboardService leaderboards;
    private LevelService levels;
    private XpService xp;
    private AchievementService achievements;

    private MatchIdentityService identity;
    private MapRotationService rotation;
    private PGMHook pgmHook;
    private TrackerRegistry trackers;

    private MapVoteService votes;
    private MapTokenService tokens;
    private MapTokenRequestPoller tokenPoller;
    private MapRatingService ratings;

    private final List<BukkitTask> tasks = new ArrayList<>();

    @Override
    public void onEnable() {
        saveDefaultConfig();
        this.config = ConfigLoader.load(getConfig());
        this.log = new SafeLogger(getLogger(), config.debugLogging);

        if (!validateConfig()) {
            log.error("Invalid configuration; disabling ZanderPGM.", null);
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        this.pgmHook = new PGMHook(this, log);
        if (!pgmHook.isPgmPresent()) {
            log.error("PGM is not installed/enabled; ZanderPGM requires PGM. Disabling.", null);
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        log.info("PGM detected; hooking match lifecycle events.");

        initServices();
        registerCommands();
        startTasks();

        if (config.feature("websocket")) {
            ws.connect();
        }
        sendServerOnline();
        logStartupSummary();
    }

    private boolean validateConfig() {
        boolean ok = true;
        if (isBlank(config.serverId)) {
            log.error("server.id is required", null);
            ok = false;
        }
        if (isBlank(config.baseUrl)) {
            log.error("api.baseUrl is required", null);
            ok = false;
        }
        if (isBlank(config.token)) {
            log.error("api.token is required", null);
            ok = false;
        }
        if (config.isPlaceholderToken()) {
            log.warn("api.token is still the placeholder 'change-me'; zander-web calls will likely be rejected.");
        }
        return ok;
    }

    private void initServices() {
        String version = getDescription().getVersion();
        this.health = new ConnectionHealth();
        this.queue = new RetryQueue<>(config.maxQueueSize, getLogger());
        this.api = new ZanderApiClient(config, health, queue, log, version);
        this.ws = new ZanderWebSocketClient(config, health, log, this::handleInbound);

        this.stats = new StatsAccumulator();
        this.snapshots = new StatsSnapshotService(stats, api);
        this.leaderboards = new LeaderboardService(stats);
        this.levels = new LevelService();
        this.xp = new XpService(config, api, levels);
        this.achievements = new AchievementService(config, api, xp);

        this.identity = new MatchIdentityService();
        this.rotation = new MapRotationService(log);

        this.votes = new MapVoteService(this, config, api, ws, rotation, log);
        this.tokens = new MapTokenService(this, config, api, ws, rotation, votes, log);
        this.tokenPoller = new MapTokenRequestPoller(this, api, tokens, log);
        this.ratings = new MapRatingService(this, config, api, ws, log);

        this.trackers = new TrackerRegistry(this);
        this.trackers.registerAll(pgmHook);
    }

    private void registerCommands() {
        bind("zpgm", new ZpgmCommand(this));
        bind("vote", new VoteCommand(this));
        bind("mapvote", new MapVoteCommand(this));
        bind("maprate", new MapRateCommand(this));
        bind("mapfeedback", new MapFeedbackCommand(this));
        bind("maprating", new MapRatingCommand(this));
    }

    private void bind(String name, org.bukkit.command.CommandExecutor executor) {
        if (getCommand(name) != null) {
            getCommand(name).setExecutor(executor);
            if (executor instanceof ZpgmCommand z) {
                getCommand(name).setTabCompleter(z);
            }
        } else {
            log.warn("Command not defined in plugin.yml: " + name);
        }
    }

    private void startTasks() {
        // Heartbeat.
        tasks.add(Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::sendHeartbeat,
                20L * config.heartbeatSeconds, 20L * config.heartbeatSeconds));

        // Retry queue.
        if (config.retryFailedEvents) {
            tasks.add(Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::flushQueue,
                    20L * config.retrySeconds, 20L * config.retrySeconds));
        }

        // Stats snapshot.
        tasks.add(Bukkit.getScheduler().runTaskTimerAsynchronously(this, () -> {
            MatchIdentityService.Identity id = identity.current();
            if (id != null && config.feature("playerStats")) {
                snapshots.flushPlayerStats(id.matchId);
            }
        }, 20L * config.saveIntervalSeconds, 20L * config.saveIntervalSeconds));

        // Map token poller.
        if (config.mapTokensEnabled && config.feature("mapTokens")) {
            tokenPoller.start(Math.max(10, config.heartbeatSeconds));
        }
    }

    // --- Queue / connection helpers -------------------------------------------

    public void flushQueue() {
        if (queue.isEmpty()) {
            return;
        }
        if (config.batchEvents) {
            List<BridgeEvent> batch = queue.drain(config.maxBatchSize);
            if (batch.isEmpty()) {
                return;
            }
            api.sendBatch(batch).thenAccept(ok -> {
                if (!ok) {
                    queue.requeueFront(batch);
                }
            });
        } else {
            List<BridgeEvent> batch = queue.drain(config.maxBatchSize);
            for (BridgeEvent e : batch) {
                api.send(e);
            }
        }
    }

    private void sendHeartbeat() {
        ServerHeartbeatEvent hb = new ServerHeartbeatEvent();
        hb.displayName = config.serverDisplayName;
        hb.environment = config.environment;
        hb.onlinePlayers = Bukkit.getOnlinePlayers().size();
        hb.maxPlayers = Bukkit.getMaxPlayers();
        MatchIdentityService.Identity id = identity.current();
        if (id != null) {
            hb.currentMatchId = id.matchId;
            hb.currentMapKey = id.mapKey;
        }
        hb.queuedEvents = queue.size();
        api.heartbeat(hb);
        ws.send(hb);
    }

    private void sendServerOnline() {
        ServerHeartbeatEvent online = new ServerHeartbeatEvent();
        online.displayName = config.serverDisplayName;
        online.environment = config.environment;
        online.onlinePlayers = Bukkit.getOnlinePlayers().size();
        online.maxPlayers = Bukkit.getMaxPlayers();
        api.heartbeat(online);
        ws.send(online);
    }

    public void reloadPluginConfig() {
        reloadConfig();
        this.config = ConfigLoader.load(getConfig());
        this.log = new SafeLogger(getLogger(), config.debugLogging);
        ws.reconnect();
        log.info("Configuration reloaded.");
    }

    // --- Inbound WebSocket control messages -----------------------------------

    private void handleInbound(JsonObject message) {
        String type = message.has("type") ? message.get("type").getAsString() : null;
        if (type == null) {
            return;
        }
        log.debug("Inbound WS message: " + type);
        switch (type) {
            case "PING" -> ws.send(new ServerHeartbeatEvent());
            case "REQUEST_STATUS" -> sendHeartbeat();
            case "REQUEST_STATS_FLUSH" -> {
                MatchIdentityService.Identity id = identity.current();
                if (id != null) {
                    Bukkit.getScheduler().runTask(this, () -> snapshots.flushPlayerStats(id.matchId));
                }
            }
            case "MAP_TOKEN_REQUEST" -> handleInboundToken(message);
            case "START_MAP_VOTE" -> Bukkit.getScheduler().runTask(this, votes::start);
            case "CANCEL_MAP_VOTE" -> Bukkit.getScheduler().runTask(this, () -> votes.cancel("remote"));
            case "FORCE_END_MAP_VOTE" -> Bukkit.getScheduler().runTask(this, votes::end);
            default -> log.debug("Unhandled inbound type: " + type);
        }
    }

    private void handleInboundToken(JsonObject message) {
        try {
            MapTokenRequest req = JsonUtil.gson().fromJson(message, MapTokenRequest.class);
            if (req != null) {
                tokens.handle(req);
            }
        } catch (Exception e) {
            log.debug("Bad inbound token request: " + e.getMessage());
        }
    }

    private void logStartupSummary() {
        log.info("ZanderPGM v" + getDescription().getVersion() + " enabled.");
        log.info("  Server: " + config.serverId + " (" + config.environment + ")");
        log.info("  API: " + config.baseUrl);
        log.info("  WebSocket: " + (config.feature("websocket") ? config.websocketUrl : "disabled"));
        log.info("  Debug logging: " + (config.debugLogging ? "on" : "off (set logging.debug: true to see per-request detail)"));
        log.info("  Feature flags: matchLifecycle=" + config.feature("matchLifecycle")
                + " playerStats=" + config.feature("playerStats")
                + " mapStats=" + config.feature("mapStats"));
        if (config.isPlaceholderToken()) {
            log.warn("api.token is still 'change-me' — matches/players/leaderboards will NOT reach zander-web until this is set.");
        }
    }

    @Override
    public void onDisable() {
        if (ws != null) {
            ws.close();
        }
        if (queue != null) {
            flushQueue();
        }
        if (api != null && config != null) {
            ServerOfflineEvent offline = new ServerOfflineEvent();
            offline.reason = "shutdown";
            try {
                api.offline(offline).get(Math.max(1, config.requestTimeoutSeconds), java.util.concurrent.TimeUnit.SECONDS);
            } catch (Exception ignored) {
            }
        }
        for (BukkitTask task : tasks) {
            task.cancel();
        }
        tasks.clear();
        if (tokenPoller != null) {
            tokenPoller.stop();
        }
        if (votes != null) {
            votes.cancel("shutdown");
        }
        if (ratings != null) {
            ratings.reset();
        }
        if (identity != null) {
            identity.clearCurrent();
        }
        if (log != null) {
            log.info("ZanderPGM disabled.");
        }
    }

    // --- Accessors used by trackers, services and commands --------------------

    public ZanderPGMConfig cfg() {
        return config;
    }

    public ZanderApiClient api() {
        return api;
    }

    public ZanderWebSocketClient ws() {
        return ws;
    }

    public ConnectionHealth health() {
        return health;
    }

    public RetryQueue<BridgeEvent> queue() {
        return queue;
    }

    public StatsAccumulator stats() {
        return stats;
    }

    public StatsSnapshotService snapshots() {
        return snapshots;
    }

    public LeaderboardService leaderboards() {
        return leaderboards;
    }

    public XpService xp() {
        return xp;
    }

    public AchievementService achievements() {
        return achievements;
    }

    public MatchIdentityService identity() {
        return identity;
    }

    public MapRotationService rotation() {
        return rotation;
    }

    public MapVoteService votes() {
        return votes;
    }

    public MapTokenService tokens() {
        return tokens;
    }

    public MapRatingService ratings() {
        return ratings;
    }

    public SafeLogger log() {
        return log;
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
