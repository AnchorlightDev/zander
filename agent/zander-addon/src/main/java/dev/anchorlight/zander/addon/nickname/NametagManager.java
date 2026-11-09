package dev.anchorlight.zander.addon.nickname;

import dev.anchorlight.zander.addon.ZanderAddonMain;
import dev.anchorlight.zander.addon.model.NicknameInfo;
import dev.anchorlight.zander.addon.service.NicknameService;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.TextColor;
import org.bukkit.Bukkit;
import org.bukkit.Color;
import org.bukkit.entity.Display;
import org.bukkit.entity.Player;
import org.bukkit.entity.TextDisplay;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerChangedWorldEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.scheduler.BukkitTask;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.Team;
import org.bukkit.util.Transformation;
import org.joml.Quaternionf;
import org.joml.Vector3f;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Above-head nicknames for a Paper gameplay server.
 *
 * The proxy owns chat and the tab list; this module owns the one surface the
 * proxy can't reach: the name floating above a player's head. When a player has
 * a visible nickname we hide their real nametag (a scoreboard team with
 * NAME_TAG_VISIBILITY = NEVER) and mount a TextDisplay showing the coloured
 * "~Nick" so it reads as a nickname and follows them. The real username is never
 * destroyed; it reappears the moment the nickname is cleared or hidden.
 *
 * Effective nicknames come from the Zander API and are polled on a timer so a
 * web/staff change propagates without a relog. The whole visual can be turned
 * off with `nicknames.nametags-enabled` (an operational switch, not a release
 * gate - the release is still controlled entirely by the zander.nickname
 * permission on the API side).
 *
 * Palette hex values mirror lib/nicknames/nicknameValidation.mjs.
 */
public class NametagManager implements Listener {

    private static final String HIDE_TEAM = "zdr_nick_hide";

    private static final Map<String, String> COLORS = new HashMap<>();
    static {
        COLORS.put("red", "#FF5555");
        COLORS.put("gold", "#FFAA00");
        COLORS.put("yellow", "#FFFF55");
        COLORS.put("green", "#55FF55");
        COLORS.put("dark_green", "#00AA00");
        COLORS.put("aqua", "#55FFFF");
        COLORS.put("dark_aqua", "#00AAAA");
        COLORS.put("blue", "#5555FF");
        COLORS.put("dark_blue", "#0000AA");
        COLORS.put("light_purple", "#FF55FF");
        COLORS.put("dark_purple", "#AA00AA");
        COLORS.put("gray", "#AAAAAA");
        COLORS.put("white", "#FFFFFF");
    }

    private final ZanderAddonMain plugin;
    private final NicknameService service;
    private final Map<UUID, UUID> displays = new HashMap<>(); // player UUID -> display entity UUID
    private final float yOffset;
    private final long refreshTicks;
    private BukkitTask task;

    public NametagManager(ZanderAddonMain plugin, NicknameService service) {
        this.plugin = plugin;
        this.service = service;
        this.yOffset = (float) plugin.getConfig().getDouble("nicknames.nametag-y-offset", 1.0);
        this.refreshTicks = Math.max(5, plugin.getConfig().getLong("nicknames.nametag-refresh-seconds", 15)) * 20L;
    }

    public void start() {
        ensureTeam();
        // Periodic refresh so web/staff changes show without a relog.
        task = Bukkit.getScheduler().runTaskTimer(plugin, this::refreshAll, refreshTicks, refreshTicks);
        for (Player p : Bukkit.getOnlinePlayers()) refresh(p);
    }

    public void stop() {
        if (task != null) task.cancel();
        for (UUID displayId : displays.values()) {
            removeEntity(displayId);
        }
        displays.clear();
        Team team = mainScoreboard().getTeam(HIDE_TEAM);
        if (team != null) {
            try {
                team.unregister();
            } catch (IllegalStateException ignored) {
            }
        }
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        refresh(event.getPlayer());
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        clear(event.getPlayer());
    }

    @EventHandler
    public void onWorldChange(PlayerChangedWorldEvent event) {
        // Passengers are dropped on a world change; rebuild after a tick.
        Player player = event.getPlayer();
        Bukkit.getScheduler().runTaskLater(plugin, () -> refresh(player), 5L);
    }

    @EventHandler
    public void onRespawn(PlayerRespawnEvent event) {
        Player player = event.getPlayer();
        Bukkit.getScheduler().runTaskLater(plugin, () -> refresh(player), 5L);
    }

    private void refreshAll() {
        for (Player p : Bukkit.getOnlinePlayers()) refresh(p);
    }

    /** Fetch (async) then apply (main thread) one player's nickname display. */
    private void refresh(Player player) {
        UUID id = player.getUniqueId();
        service.fetch(id, player.getName()).thenAccept(info ->
                Bukkit.getScheduler().runTask(plugin, () -> {
                    Player online = Bukkit.getPlayer(id);
                    if (online != null && online.isOnline()) apply(online, info);
                }));
    }

    private void apply(Player player, NicknameInfo info) {
        if (info != null && info.isNick && info.nickname != null) {
            hideRealName(player, true);
            mountDisplay(player, nickComponent(info));
        } else {
            hideRealName(player, false);
            clearDisplay(player);
        }
    }

    private Component nickComponent(NicknameInfo info) {
        Component text = Component.text("~" + info.nickname);
        String hex = info.color != null ? COLORS.get(info.color) : null;
        if (hex != null) {
            TextColor tc = TextColor.fromHexString(hex);
            if (tc != null) text = text.color(tc);
        }
        return text;
    }

    private void mountDisplay(Player player, Component text) {
        UUID existingId = displays.get(player.getUniqueId());
        if (existingId != null) {
            if (Bukkit.getEntity(existingId) instanceof TextDisplay existing
                    && existing.isValid()
                    && player.getPassengers().contains(existing)) {
                existing.text(text);
                return;
            }
            removeEntity(existingId); // stale/unmounted; rebuild
        }

        TextDisplay display = player.getWorld().spawn(player.getLocation(), TextDisplay.class, d -> {
            d.text(text);
            d.setBillboard(Display.Billboard.CENTER);
            d.setSeeThrough(true);
            d.setShadowed(false);
            d.setAlignment(TextDisplay.TextAlignment.CENTER);
            d.setBackgroundColor(Color.fromARGB(0, 0, 0, 0));
            d.setTransformation(new Transformation(
                    new Vector3f(0f, yOffset, 0f),
                    new Quaternionf(),
                    new Vector3f(1f, 1f, 1f),
                    new Quaternionf()));
            d.setPersistent(false);
        });
        player.addPassenger(display);
        displays.put(player.getUniqueId(), display.getUniqueId());
    }

    private void clearDisplay(Player player) {
        UUID displayId = displays.remove(player.getUniqueId());
        if (displayId != null) removeEntity(displayId);
    }

    private void clear(Player player) {
        clearDisplay(player);
        hideRealName(player, false);
    }

    private void hideRealName(Player player, boolean hide) {
        Team team = ensureTeam();
        String entry = player.getName();
        if (hide) {
            if (!team.hasEntry(entry)) team.addEntry(entry);
        } else if (team.hasEntry(entry)) {
            team.removeEntry(entry);
        }
    }

    private Team ensureTeam() {
        Scoreboard board = mainScoreboard();
        Team team = board.getTeam(HIDE_TEAM);
        if (team == null) team = board.registerNewTeam(HIDE_TEAM);
        team.setOption(Team.Option.NAME_TAG_VISIBILITY, Team.OptionStatus.NEVER);
        return team;
    }

    private Scoreboard mainScoreboard() {
        return Bukkit.getScoreboardManager().getMainScoreboard();
    }

    private void removeEntity(UUID entityId) {
        if (entityId == null) return;
        if (Bukkit.getEntity(entityId) instanceof TextDisplay display) {
            display.remove();
        }
    }
}
