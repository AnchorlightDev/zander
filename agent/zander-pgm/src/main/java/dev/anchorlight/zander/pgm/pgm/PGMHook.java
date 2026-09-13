package dev.anchorlight.zander.pgm.pgm;

import org.bukkit.Bukkit;
import org.bukkit.event.Event;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.plugin.EventExecutor;
import org.bukkit.plugin.Plugin;
import dev.anchorlight.zander.pgm.util.SafeLogger;

/**
 * Bridges PGM's match lifecycle events into zander-pgm. PGM event classes are
 * resolved by name and registered via a Bukkit {@link EventExecutor}, so this
 * module has no compile-time dependency on PGM and degrades gracefully when PGM
 * is absent.
 */
public class PGMHook implements Listener {

    private static final String[] LOAD_EVENTS = {
            "tc.oc.pgm.api.match.event.MatchLoadEvent"
    };
    private static final String[] START_EVENTS = {
            "tc.oc.pgm.api.match.event.MatchStartEvent"
    };
    private static final String[] FINISH_EVENTS = {
            "tc.oc.pgm.api.match.event.MatchFinishEvent"
    };

    private final Plugin plugin;
    private final SafeLogger logger;

    /** Callback surface implemented by MatchTracker. */
    public interface MatchLifecycleListener {
        void onMatchLoad(Object match);

        void onMatchStart(Object match);

        void onMatchFinish(Object match);
    }

    public PGMHook(Plugin plugin, SafeLogger logger) {
        this.plugin = plugin;
        this.logger = logger;
    }

    public boolean isPgmPresent() {
        return Bukkit.getPluginManager().getPlugin("PGM") != null;
    }

    public void register(MatchLifecycleListener cb) {
        registerAll(LOAD_EVENTS, cb::onMatchLoad);
        registerAll(START_EVENTS, cb::onMatchStart);
        registerAll(FINISH_EVENTS, cb::onMatchFinish);
    }

    private void registerAll(String[] classNames, java.util.function.Consumer<Object> handler) {
        for (String className : classNames) {
            Class<?> eventClass = resolve(className);
            if (eventClass == null) {
                logger.debug("PGM event not found: " + className);
                continue;
            }
            EventExecutor executor = (listener, event) -> {
                try {
                    Object match = PGMUtils.getMatch(event);
                    if (match != null) {
                        handler.accept(match);
                    }
                } catch (Throwable t) {
                    logger.debug("PGM event handler error: " + t.getMessage());
                }
            };
            @SuppressWarnings("unchecked")
            Class<? extends Event> ec = (Class<? extends Event>) eventClass;
            Bukkit.getPluginManager().registerEvent(ec, this, EventPriority.MONITOR, executor, plugin, true);
            logger.debug("Registered PGM listener for " + className);
        }
    }

    private Class<?> resolve(String name) {
        try {
            return Class.forName(name);
        } catch (Throwable t) {
            return null;
        }
    }
}
