package dev.anchorlight.zander.pgm.pgm;

import dev.anchorlight.zander.pgm.util.SafeLogger;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Reflective view over PGM's map library and rotation, plus the plugin-managed
 * "next map override" used by Map Tokens and Map Voting. All overrides apply to
 * the NEXT match only and never interrupt a running match.
 */
public class MapRotationService {

    private final SafeLogger logger;
    private final AtomicReference<String> nextMapOverride = new AtomicReference<>();

    public MapRotationService(SafeLogger logger) {
        this.logger = logger;
    }

    /** All map names known to PGM, best-effort via reflection. */
    public List<String> availableMapNames() {
        List<String> names = new ArrayList<>();
        try {
            Class<?> pgmClass = Class.forName("tc.oc.pgm.api.PGM");
            Object pgm = pgmClass.getMethod("get").invoke(null);
            Object library = PGMUtils.call(pgm, "getMapLibrary");
            Object maps = PGMUtils.call(library, "getMaps");
            if (maps instanceof Iterable<?> it) {
                for (Object m : it) {
                    String name = PGMUtils.mapName(m);
                    if (name != null) {
                        names.add(name);
                    }
                }
            }
        } catch (Throwable t) {
            logger.debug("Could not enumerate PGM maps: " + t.getMessage());
        }
        return names;
    }

    public boolean mapExists(String mapKeyOrName) {
        if (mapKeyOrName == null) {
            return false;
        }
        return availableMapNames().stream().anyMatch(n -> n.equalsIgnoreCase(mapKeyOrName));
    }

    public void setNextMapOverride(String mapKeyOrName) {
        nextMapOverride.set(mapKeyOrName);
        logger.info("Next map override set to: " + mapKeyOrName);
    }

    public Optional<String> nextMapOverride() {
        return Optional.ofNullable(nextMapOverride.get());
    }

    public void clearNextMapOverride() {
        nextMapOverride.set(null);
        logger.info("Next map override cleared");
    }

    /**
     * Attempt to apply the pending override to PGM's rotation for the next match.
     * Best-effort; returns whether an override was applied.
     */
    public boolean applyOverrideToRotation() {
        String map = nextMapOverride.get();
        if (map == null) {
            return false;
        }
        try {
            Class<?> pgmClass = Class.forName("tc.oc.pgm.api.PGM");
            Object pgm = pgmClass.getMethod("get").invoke(null);
            Object library = PGMUtils.call(pgm, "getMapLibrary");
            Object mapInfo = null;
            Object maps = PGMUtils.call(library, "getMaps");
            if (maps instanceof Iterable<?> it) {
                for (Object m : it) {
                    if (map.equalsIgnoreCase(PGMUtils.mapName(m))) {
                        mapInfo = m;
                        break;
                    }
                }
            }
            if (mapInfo == null) {
                return false;
            }
            // PGM's MapOrder/setNextMap API varies by version; done reflectively.
            Object matchManager = PGMUtils.call(pgm, "getMatchManager");
            Object mapOrder = PGMUtils.call(matchManager, "getMapOrder");
            if (mapOrder != null) {
                for (var method : mapOrder.getClass().getMethods()) {
                    if (method.getName().equals("setNextMap") && method.getParameterCount() == 1) {
                        method.invoke(mapOrder, mapInfo);
                        logger.info("Applied next map override to PGM rotation: " + map);
                        return true;
                    }
                }
            }
        } catch (Throwable t) {
            logger.debug("Could not apply map override: " + t.getMessage());
        }
        return false;
    }
}
