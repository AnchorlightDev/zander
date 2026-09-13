package dev.anchorlight.zander.pgm.pgm;

import java.util.ArrayList;
import java.util.List;

/**
 * Reflective helpers for reading values off PGM objects (Match, MapInfo, ...).
 * PGM is integrated reflectively so the plugin compiles without the PGM artifact
 * on the classpath; every accessor is best-effort and null/empty-safe.
 */
public final class PGMUtils {

    private PGMUtils() {
    }

    public static Object call(Object target, String method) {
        if (target == null) {
            return null;
        }
        try {
            var m = target.getClass().getMethod(method);
            m.setAccessible(true);
            return m.invoke(target);
        } catch (Throwable t) {
            return null;
        }
    }

    public static String str(Object target, String method) {
        Object v = call(target, method);
        return v == null ? null : String.valueOf(v);
    }

    public static Object getMatch(Object event) {
        return call(event, "getMatch");
    }

    public static Object getMap(Object match) {
        Object map = call(match, "getMap");
        return map != null ? map : call(match, "getMapInfo");
    }

    public static String matchId(Object match) {
        return str(match, "getId");
    }

    public static String mapName(Object map) {
        return str(map, "getName");
    }

    public static String mapId(Object map) {
        String id = str(map, "getId");
        return id != null ? id : mapName(map);
    }

    public static String mapVersion(Object map) {
        Object v = call(map, "getVersion");
        return v == null ? null : String.valueOf(v);
    }

    @SuppressWarnings("unchecked")
    public static List<String> mapAuthors(Object map) {
        List<String> out = new ArrayList<>();
        Object contributors = call(map, "getAuthors");
        if (contributors instanceof Iterable<?> it) {
            for (Object c : it) {
                Object name = call(c, "getName");
                out.add(name == null ? String.valueOf(c) : String.valueOf(name));
            }
        }
        return out;
    }

    /** Best-effort list of participating player usernames in a match. */
    public static List<String> participantNames(Object match) {
        List<String> out = new ArrayList<>();
        Object players = call(match, "getPlayers");
        if (players instanceof Iterable<?> it) {
            for (Object p : it) {
                Object name = call(p, "getNameLegacy");
                if (name == null) {
                    name = call(p, "getName");
                }
                if (name != null) {
                    out.add(String.valueOf(name));
                }
            }
        }
        return out;
    }
}
