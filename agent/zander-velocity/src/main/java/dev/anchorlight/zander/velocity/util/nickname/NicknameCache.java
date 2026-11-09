package dev.anchorlight.zander.velocity.util.nickname;

import com.jayway.jsonpath.DocumentContext;
import com.jayway.jsonpath.JsonPath;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.player.TabListEntry;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.HoverEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Per-player effective-nickname cache for the proxy.
 *
 * The proxy never touches the database: it asks the Zander API
 * (GET /api/nickname/effective) what a player should display as, caches it with
 * a short TTL, and refreshes on join/switch and immediately after a /nick change.
 * The TTL means staff actions on the web propagate without a relog.
 *
 * Every display surface (chat, whispers, tab list) renders through
 * {@link #displayName(Player)} so a nickname always shows with a ~ marker and a
 * hover revealing the real username.
 */
public final class NicknameCache {

    private NicknameCache() {
    }

    /** TTL so web/staff changes propagate without a relog. */
    private static final long TTL_MS = 30_000L;

    /** Palette key -> hex, mirroring lib/nicknames/nicknameValidation.mjs. */
    private static final Map<String, String> COLORS = Map.ofEntries(
            Map.entry("red", "#FF5555"),
            Map.entry("gold", "#FFAA00"),
            Map.entry("yellow", "#FFFF55"),
            Map.entry("green", "#55FF55"),
            Map.entry("dark_green", "#00AA00"),
            Map.entry("aqua", "#55FFFF"),
            Map.entry("dark_aqua", "#00AAAA"),
            Map.entry("blue", "#5555FF"),
            Map.entry("dark_blue", "#0000AA"),
            Map.entry("light_purple", "#FF55FF"),
            Map.entry("dark_purple", "#AA00AA"),
            Map.entry("gray", "#AAAAAA"),
            Map.entry("white", "#FFFFFF")
    );

    public static final class Effective {
        public final String realname;
        public final String nickname; // null when none / hidden
        public final String color;    // null = default colour
        public final boolean isNick;
        public final long fetchedAt;

        Effective(String realname, String nickname, String color, boolean isNick) {
            this.realname = realname;
            this.nickname = nickname;
            this.color = color;
            this.isNick = isNick;
            this.fetchedAt = System.currentTimeMillis();
        }

        boolean fresh() {
            return System.currentTimeMillis() - fetchedAt < TTL_MS;
        }
    }

    private static final Map<UUID, Effective> CACHE = new ConcurrentHashMap<>();

    public static void invalidate(UUID uuid) {
        CACHE.remove(uuid);
    }

    /** Build the display name component for a player (nickname-aware). */
    public static Component displayName(Player player) {
        Effective e = CACHE.get(player.getUniqueId());
        if (e != null && e.isNick && e.nickname != null) {
            Component name = Component.text("~" + e.nickname);
            String hex = e.color != null ? COLORS.get(e.color) : null;
            if (hex != null) {
                TextColor tc = TextColor.fromHexString(hex);
                if (tc != null) {
                    name = name.color(tc);
                }
            }
            Component hover = Component.text("Real name: " + e.realname).color(NamedTextColor.GRAY);
            return name.hoverEvent(HoverEvent.showText(hover));
        }
        return Component.text(player.getUsername());
    }

    /**
     * Fetch the effective nickname from the API (blocking — call from a
     * scheduler task), update the cache and return it. On any error the player
     * falls back to their real username.
     */
    public static Effective fetch(UUID uuid, String fallbackName) {
        String base = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String apiKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));
        try {
            Request req = Request.builder()
                    .setURL(base + "/nickname/effective?uuid=" + uuid)
                    .setMethod(Request.Method.GET)
                    .addHeader("x-access-token", apiKey)
                    .build();

            String json = req.execute().getBody();
            DocumentContext doc = JsonPath.parse(json);

            boolean success = Boolean.TRUE.equals(readBool(doc, "$.success"));
            if (!success) {
                return store(uuid, new Effective(fallbackName, null, null, false));
            }

            boolean isNick = Boolean.TRUE.equals(readBool(doc, "$.data.isNick"));
            String realname = readString(doc, "$.data.realname", fallbackName);
            String nickname = readString(doc, "$.data.nickname", null);
            String color = readString(doc, "$.data.color", null);
            return store(uuid, new Effective(realname, nickname, color, isNick));
        } catch (Exception e) {
            ZanderVelocityMain.getLogger().warn("Nickname lookup failed for {}: {}", uuid, e.getMessage());
            return store(uuid, new Effective(fallbackName, null, null, false));
        }
    }

    /**
     * Refresh a player's nickname from the API, then reapply tab-list names so
     * every connected player sees the change without a relog.
     */
    public static void refreshAsync(Player player) {
        ZanderVelocityMain.getProxy().getScheduler()
                .buildTask(ZanderVelocityMain.getInstance(), () -> {
                    fetch(player.getUniqueId(), player.getUsername());
                    applyTabForSubject(player);
                }).schedule();
    }

    /** Set this player's tab-list display name in every viewer's tab list. */
    public static void applyTabForSubject(Player subject) {
        Component disp = displayName(subject);
        UUID id = subject.getUniqueId();
        for (Player viewer : ZanderVelocityMain.getProxy().getAllPlayers()) {
            for (TabListEntry entry : viewer.getTabList().getEntries()) {
                if (entry.getProfile().getId().equals(id)) {
                    entry.setDisplayName(disp);
                    break;
                }
            }
        }
    }

    /** Apply known nicknames to all of one viewer's tab entries (used on join). */
    public static void applyAllTabsForViewer(Player viewer) {
        for (TabListEntry entry : viewer.getTabList().getEntries()) {
            UUID id = entry.getProfile().getId();
            Effective e = CACHE.get(id);
            if (e != null && e.isNick && e.nickname != null) {
                ZanderVelocityMain.getProxy().getPlayer(id)
                        .ifPresent(p -> entry.setDisplayName(displayName(p)));
            }
        }
    }

    private static Effective store(UUID uuid, Effective e) {
        CACHE.put(uuid, e);
        return e;
    }

    private static Boolean readBool(DocumentContext doc, String path) {
        try {
            return doc.read(path, Boolean.class);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String readString(DocumentContext doc, String path, String fallback) {
        try {
            Object v = doc.read(path);
            return v == null ? fallback : String.valueOf(v);
        } catch (Exception ignored) {
            return fallback;
        }
    }
}
