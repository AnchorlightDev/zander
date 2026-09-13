package dev.anchorlight.zander.hub.events;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import net.md_5.bungee.api.ChatColor;
import org.bukkit.Bukkit;
import org.bukkit.Color;
import org.bukkit.FireworkEffect;
import org.bukkit.Location;
import org.bukkit.Sound;
import org.bukkit.entity.Firework;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerLoginEvent;
import org.bukkit.inventory.meta.FireworkMeta;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.Team;
import dev.anchorlight.zander.hub.ConfigurationManager;
import dev.anchorlight.zander.hub.items.NavigationCompassItem;
import dev.anchorlight.zander.hub.utils.Misc;
import dev.anchorlight.zander.hub.utils.WelcomeSounds;

public class HubPlayerJoin implements Listener {
    // misc settings
    private static final long ROUTINE_PLAYER_JOINED_DELAY = (long) (1.2f * 20); // ticks

    // sound settings
    private static final float SOUND_PITCH = 1.0f;
    private static final float SOUND_VOLUME = 1.0f;

    // firework settings
    private static final double FIREWORK_GROUND_HEIGHT = 3; // blocks
    private static final long FIREWORK_DETONATE_DELAY = (long) (0.3f * 20); // ticks
    private static final Color[] FIREWORK_COLOR_PALETTE = {
            Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW, Color.PURPLE,
            Color.ORANGE, Color.WHITE, Color.AQUA, Color.LIME,
    };

    private final JavaPlugin plugin;

    public HubPlayerJoin(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    /// Triggers when player's client first connects.
    /// Good for validation and basic setup (permission, flags, etc).
    @EventHandler
    public void onPlayerLogin(PlayerLoginEvent event) {
        Player player = event.getPlayer();
        setPermissions(player);
    }

    /// Triggers when player's client has joined the world.
    /// Good for initial player world interactions (gameplay state etc).
    /// Runs at LOW priority so the inventory clear happens before other
    /// plugins (e.g. zander-addon) give join items at NORMAL/HIGH priority.
    @EventHandler(priority = EventPriority.LOW)
    public void onPlayerJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        setInitialState(player); // * just be aware, runs before checking vanish
        if (Misc.isVanish(player))
            return;
        event.joinMessage(ConfigurationManager.getMessages().getPlayerJoin(player.displayName()));
        Bukkit.getScheduler().runTaskLater(plugin, () -> scheduledLogin(player), ROUTINE_PLAYER_JOINED_DELAY);
    }

    /// Set special permission depending on the player.
    private void setPermissions(Player player) {
        if (player.hasPermission("zander.hub.fly")) {
            player.setAllowFlight(true);
        }
    }

    /// Set the initial state of the player in the world.
    private void setInitialState(Player player) {
        int compassSlot = ConfigurationManager.getMisc().getSlotHubCompass();
        setupNoCollision(player);
        player.teleport(ConfigurationManager.getHubLocations().getSpawn());
        player.getInventory().clear();
        player.getInventory().setHeldItemSlot(compassSlot);
        player.getInventory().setItem(compassSlot, NavigationCompassItem.createCompass());
    }

    /// Delayed login triggers (logic that's not immediate on login).
    private void scheduledLogin(Player player) {
        if (!player.isConnected())
            return;
        // * bukkit determines by reading 'world/playerdata'
        if (!player.hasPlayedBefore() || ConfigurationManager.getMisc().getAlwaysFirstJoin()) {
            chatWelcomeMessageFirst(player);
            spawnWelcomeFirework(player);
        } else {
            chatWelcomeMessageNormal(player);
        }
        playWelcomeSound(player);
    }

    /// Disable entity collision for player.
    /// Correct way as mentioned at:
    /// https://hub.spigotmc.org/javadocs/bukkit/org/bukkit/entity/LivingEntity.html#setCollidable(boolean)
    private void setupNoCollision(Player player) {
        Scoreboard scoreboard = Bukkit.getScoreboardManager().getMainScoreboard();
        Team team = scoreboard.getTeam("nocollision");
        if (team == null) {
            team = scoreboard.registerNewTeam("nocollision");
            team.setOption(Team.Option.COLLISION_RULE, Team.OptionStatus.NEVER);
        }
        team.addEntry(player.getName());
    }

    /// Send a 'normal welcome' message in player's chat.
    private void chatWelcomeMessageNormal(Player player) {
        List<String> message = ConfigurationManager.getWelcome().getStringList("welcome");
        for (String row : message)
            player.sendMessage(ChatColor.translateAlternateColorCodes('&', row));
    }

    /// Send a 'new player welcome' message in player's chat.
    private void chatWelcomeMessageFirst(Player player) {
        List<String> message = ConfigurationManager.getWelcome().getStringList("welcome_newplayer");
        for (String row : message)
            player.sendMessage(ChatColor.translateAlternateColorCodes('&', row));
    }

    /// Play a random sound for the player.
    private void playWelcomeSound(Player player) {
        Sound randomSound = WelcomeSounds.getRandomSound();
        player.playSound(player.getLocation(), randomSound, SOUND_VOLUME, SOUND_PITCH);
    }

    /// Spawn a pretty firework where the player is.
    private void spawnWelcomeFirework(Player player) {
        Location spawnLoc = player.getLocation().add(0, FIREWORK_GROUND_HEIGHT, 0);
        Firework firework = player.getWorld().spawn(spawnLoc, Firework.class);
        FireworkMeta meta = firework.getFireworkMeta();

        Random random = new Random();
        Color[] FCP = FIREWORK_COLOR_PALETTE;

        // random primary-colors
        List<Color> colors = new ArrayList<>();
        int numColors = random.nextInt(3) + 2; // 2-4 colors
        for (int i = 0; i < numColors; i++) {
            colors.add(FCP[random.nextInt(FCP.length)]);
        }

        // random fade-color and firework type
        Color fadeColor = FCP[random.nextInt(FCP.length)];
        FireworkEffect.Type[] types = FireworkEffect.Type.values();
        FireworkEffect.Type type = types[random.nextInt(types.length)];

        FireworkEffect effect = FireworkEffect.builder()
                .flicker(false)
                .trail(true)
                .with(type)
                .withColor(colors)
                .withFade(fadeColor)
                .build();
        meta.addEffect(effect);
        meta.setPower(1);
        firework.setFireworkMeta(meta);

        Bukkit.getScheduler().runTaskLater(plugin, () -> {
            if (firework.isValid())
                firework.detonate();
        }, FIREWORK_DETONATE_DELAY);
    }
}
