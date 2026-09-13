package dev.anchorlight.zander.pgm.tracker;

import org.bukkit.Bukkit;
import org.bukkit.event.Listener;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.pgm.PGMHook;

/**
 * Constructs and registers all trackers as Bukkit listeners and wires the match
 * lifecycle tracker into the PGM hook.
 */
public class TrackerRegistry {

    private final ZanderPGMPlugin plugin;
    private MatchTracker matchTracker;

    public TrackerRegistry(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    public void registerAll(PGMHook pgmHook) {
        MapStatsTracker mapStatsTracker = new MapStatsTracker(plugin);
        matchTracker = new MatchTracker(plugin, mapStatsTracker);
        PlayerTracker playerTracker = new PlayerTracker(plugin, matchTracker);
        BigStatsTracker bigStatsTracker = new BigStatsTracker(plugin);
        SessionTracker sessionTracker = new SessionTracker(plugin);
        ObjectiveTracker objectiveTracker = new ObjectiveTracker(plugin);

        registerListener(playerTracker);
        registerListener(bigStatsTracker);
        registerListener(sessionTracker);

        // PGM lifecycle + objective events (reflective registration).
        pgmHook.register(matchTracker);
        objectiveTracker.register();

        plugin.log().info("Registered trackers: match, player, bigStats, session, objective");
    }

    private void registerListener(Listener listener) {
        Bukkit.getPluginManager().registerEvents(listener, plugin);
    }

    public MatchTracker matchTracker() {
        return matchTracker;
    }
}
