package dev.anchorlight.zander.pgm.tracker;

import org.bukkit.Bukkit;
import org.bukkit.event.Event;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.plugin.EventExecutor;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.api.dto.ObjectiveEventDto;
import dev.anchorlight.zander.pgm.pgm.MatchIdentityService;
import dev.anchorlight.zander.pgm.pgm.PGMUtils;
import dev.anchorlight.zander.pgm.progression.XpService;
import dev.anchorlight.zander.pgm.stats.PlayerStats;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Subscribes reflectively to PGM objective events (wool/flag/core/destroyable/
 * control-point) and emits the generic {@link ObjectiveEventDto}, updating player
 * objective stats through the per-type trackers. PGM event classes vary by
 * version; unknown ones are skipped without error.
 */
public class ObjectiveTracker implements Listener {

    /** className -> {objectiveType, action}. Best-effort across PGM versions. */
    private static final Map<String, String[]> EVENTS = new LinkedHashMap<>();

    static {
        EVENTS.put("tc.oc.pgm.wool.PlayerWoolPlaceEvent", new String[]{WoolTracker.TYPE, "PLACE"});
        EVENTS.put("tc.oc.pgm.flag.event.FlagCaptureEvent", new String[]{FlagTracker.TYPE, "CAPTURE"});
        EVENTS.put("tc.oc.pgm.flag.event.FlagStateChangeEvent", new String[]{FlagTracker.TYPE, "STATE"});
        EVENTS.put("tc.oc.pgm.destroyable.DestroyableDestroyedEvent", new String[]{DestroyableTracker.TYPE, "DESTROYED"});
        EVENTS.put("tc.oc.pgm.core.CoreLeakEvent", new String[]{CoreTracker.TYPE, "LEAK"});
        EVENTS.put("tc.oc.pgm.controlpoint.events.ControllerChangeEvent", new String[]{ControlPointTracker.TYPE, "OWNER_CHANGE"});
    }

    private final ZanderPGMPlugin plugin;
    private final WoolTracker wool = new WoolTracker();
    private final FlagTracker flag = new FlagTracker();
    private final CoreTracker core = new CoreTracker();
    private final DestroyableTracker destroyable = new DestroyableTracker();
    private final ControlPointTracker controlPoint = new ControlPointTracker();

    public ObjectiveTracker(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    public void register() {
        if (!plugin.cfg().feature("objectiveStats")) {
            return;
        }
        for (Map.Entry<String, String[]> entry : EVENTS.entrySet()) {
            Class<?> ec = resolve(entry.getKey());
            if (ec == null) {
                plugin.log().debug("PGM objective event not found: " + entry.getKey());
                continue;
            }
            String[] meta = entry.getValue();
            EventExecutor executor = (listener, event) -> handle(event, meta[0], meta[1]);
            @SuppressWarnings("unchecked")
            Class<? extends Event> cast = (Class<? extends Event>) ec;
            Bukkit.getPluginManager().registerEvent(cast, this, EventPriority.MONITOR, executor, plugin, true);
        }
    }

    private void handle(Object event, String type, String action) {
        try {
            UUID uuid = resolveUuid(event);
            String name = resolveName(event);
            MatchIdentityService.Identity id = plugin.identity().current();

            ObjectiveEventDto dto = new ObjectiveEventDto();
            dto.objectiveType = type;
            dto.action = action;
            dto.uuid = uuid != null ? uuid.toString() : null;
            dto.username = name;
            if (id != null) {
                dto.matchId = id.matchId;
                dto.mapKey = id.mapKey;
                dto.mapName = id.mapName;
            }
            dto.raw.put("event", event.getClass().getSimpleName());
            plugin.api().send(dto);
            plugin.ws().send(dto);

            if (uuid != null) {
                PlayerStats stats = plugin.stats().player(uuid, name);
                applyToStats(type, stats, action);
                awardXp(type, stats, action, dto.matchId);
                plugin.achievements().evaluate(stats, dto.matchId);
            }
        } catch (Throwable t) {
            plugin.log().debug("Objective handling error: " + t.getMessage());
        }
    }

    private void applyToStats(String type, PlayerStats stats, String action) {
        switch (type) {
            case WoolTracker.TYPE -> wool.apply(stats, action);
            case FlagTracker.TYPE -> flag.apply(stats, action);
            case CoreTracker.TYPE -> core.apply(stats, action);
            case DestroyableTracker.TYPE -> destroyable.apply(stats, action, 0);
            case ControlPointTracker.TYPE -> controlPoint.apply(stats, action);
            default -> { }
        }
    }

    private void awardXp(String type, PlayerStats stats, String action, String matchId) {
        boolean capture = switch (type) {
            case WoolTracker.TYPE, FlagTracker.TYPE -> "PLACE".equals(action) || "CAPTURE".equals(action);
            case CoreTracker.TYPE -> "LEAK".equals(action);
            case DestroyableTracker.TYPE -> "DESTROYED".equals(action);
            case ControlPointTracker.TYPE -> "OWNER_CHANGE".equals(action) || "CAPTURE".equals(action);
            default -> false;
        };
        if (capture) {
            plugin.xp().award(stats, XpService.Reason.OBJECTIVE_CAPTURE, matchId);
        }
    }

    private UUID resolveUuid(Object event) {
        Object player = firstNonNull(PGMUtils.call(event, "getPlayer"), PGMUtils.call(event, "getActor"));
        Object id = PGMUtils.call(player, "getId");
        if (id instanceof UUID u) {
            return u;
        }
        Object bukkit = PGMUtils.call(player, "getBukkit");
        Object uid = PGMUtils.call(bukkit, "getUniqueId");
        return uid instanceof UUID u ? u : null;
    }

    private String resolveName(Object event) {
        Object player = firstNonNull(PGMUtils.call(event, "getPlayer"), PGMUtils.call(event, "getActor"));
        String name = PGMUtils.str(player, "getNameLegacy");
        return name != null ? name : PGMUtils.str(player, "getName");
    }

    private Object firstNonNull(Object a, Object b) {
        return a != null ? a : b;
    }

    private Class<?> resolve(String name) {
        try {
            return Class.forName(name);
        } catch (Throwable t) {
            return null;
        }
    }
}
