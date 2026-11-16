package dev.anchorlight.zander.hub.seasonal;

import io.papermc.paper.registry.RegistryAccess;
import io.papermc.paper.registry.RegistryKey;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.block.Biome;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockFormEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitRunnable;

import java.io.File;
import java.io.IOException;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Seasonal hub snow (config: seasonal-snow).
 *
 * During the configured months (December by default) the hub area is switched
 * to a snowy biome and kept raining, so the client renders snowfall. Snow
 * layers and ice are never allowed to form in the hub world. Outside the season
 * the area is switched back to the normal biome and the weather cleared.
 *
 * Whether the snow biome is currently applied is stored in
 * plugins/ZanderHub/seasonal-snow.yml, so a restart mid-season does not redo the
 * work and the revert happens exactly once after the season ends.
 */
public class SeasonalSnow implements Listener {

    private static final long CHECK_INTERVAL_TICKS = 20L * 60 * 5; // 5 minutes
    private static final int WEATHER_DURATION_TICKS = 20 * 60 * 30; // refreshed well before it runs out
    private static final int CHUNKS_PER_TICK = 4;

    private final JavaPlugin plugin;
    private final File stateFile;

    private boolean enabled;
    private boolean force;
    private boolean blockSnowAndIce;
    private Set<Integer> months;
    private ZoneId zone;
    private String worldName;
    private int centreX;
    private int centreZ;
    private int radius;
    private int minY;
    private int maxY;
    private Biome snowBiome;
    private Biome normalBiome;

    private boolean applied;
    private boolean working;

    public SeasonalSnow(JavaPlugin plugin) {
        this.plugin = plugin;
        this.stateFile = new File(plugin.getDataFolder(), "seasonal-snow.yml");
    }

    public void start() {
        loadConfig();
        applied = YamlConfiguration.loadConfiguration(stateFile).getBoolean("applied", false);
        if (!enabled) {
            plugin.getLogger().info("[SeasonalSnow] Disabled in config.");
            // Still revert if a previous season was left applied.
        }
        Bukkit.getScheduler().runTaskTimer(plugin, this::tick, 40L, CHECK_INTERVAL_TICKS);
    }

    private void loadConfig() {
        ConfigurationSection c = plugin.getConfig().getConfigurationSection("seasonal-snow");
        if (c == null) c = plugin.getConfig().createSection("seasonal-snow");

        enabled = c.getBoolean("enabled", true);
        force = c.getBoolean("force", false);
        blockSnowAndIce = c.getBoolean("block-snow-and-ice", true);

        months = new HashSet<>();
        for (Integer m : c.getIntegerList("months")) {
            if (m != null && m >= 1 && m <= 12) months.add(m);
        }
        if (months.isEmpty()) months.add(12);

        try {
            zone = ZoneId.of(c.getString("timezone", "Australia/Sydney"));
        } catch (DateTimeException e) {
            plugin.getLogger().warning("[SeasonalSnow] Invalid timezone, using the server's.");
            zone = ZoneId.systemDefault();
        }

        worldName = c.getString("world", plugin.getConfig().getString("hub.world", "world"));
        centreX = (int) Math.floor(plugin.getConfig().getDouble("hub.x", 0));
        centreZ = (int) Math.floor(plugin.getConfig().getDouble("hub.z", 0));
        radius = Math.max(16, c.getInt("radius", 160));
        minY = c.getInt("min-y", 0);
        maxY = Math.max(minY, c.getInt("max-y", 256));

        snowBiome = biome(c.getString("snow-biome", "minecraft:snowy_plains"), "snow-biome");
        normalBiome = biome(c.getString("normal-biome", "minecraft:plains"), "normal-biome");
    }

    private Biome biome(String id, String field) {
        NamespacedKey key = NamespacedKey.fromString(id == null ? "" : id.toLowerCase());
        Biome found = key == null ? null : RegistryAccess.registryAccess().getRegistry(RegistryKey.BIOME).get(key);
        if (found == null) {
            plugin.getLogger().warning("[SeasonalSnow] Unknown biome '" + id + "' for " + field + ".");
        }
        return found;
    }

    private boolean inSeason() {
        if (!enabled) return false;
        if (force) return true;
        return months.contains(LocalDate.now(zone).getMonthValue());
    }

    private void tick() {
        World world = Bukkit.getWorld(worldName);
        if (world == null || working) return;

        boolean season = inSeason();
        if (season) {
            // Keep it snowing; re-applied every check so the natural weather
            // timer never gets to clear it.
            world.setStorm(true);
            world.setThundering(false);
            world.setWeatherDuration(WEATHER_DURATION_TICKS);
            if (!applied && snowBiome != null) {
                plugin.getLogger().info("[SeasonalSnow] Season started, applying snow biome.");
                paintBiome(world, snowBiome, true);
            }
        } else if (applied && normalBiome != null) {
            plugin.getLogger().info("[SeasonalSnow] Season over, restoring normal biome.");
            world.setStorm(false);
            world.setThundering(false);
            paintBiome(world, normalBiome, false);
        }
    }

    /** Set the biome over the hub area a few chunks per tick, then resend those chunks. */
    private void paintBiome(World world, Biome biome, boolean appliedAfter) {
        working = true;
        int minX = centreX - radius, maxX = centreX + radius;
        int minZ = centreZ - radius, maxZ = centreZ + radius;
        int lowY = Math.max(minY, world.getMinHeight());
        int highY = Math.min(maxY, world.getMaxHeight() - 1);

        List<int[]> chunks = new ArrayList<>();
        for (int cx = minX >> 4; cx <= maxX >> 4; cx++) {
            for (int cz = minZ >> 4; cz <= maxZ >> 4; cz++) {
                chunks.add(new int[]{cx, cz});
            }
        }

        new BukkitRunnable() {
            int index = 0;

            @Override
            public void run() {
                for (int n = 0; n < CHUNKS_PER_TICK && index < chunks.size(); n++, index++) {
                    int cx = chunks.get(index)[0], cz = chunks.get(index)[1];
                    int x0 = Math.max(minX, cx << 4), x1 = Math.min(maxX, (cx << 4) + 15);
                    int z0 = Math.max(minZ, cz << 4), z1 = Math.min(maxZ, (cz << 4) + 15);
                    // Biomes are stored per 4x4x4 cell, so one call per cell is enough.
                    for (int x = x0; x <= x1; x += 4) {
                        for (int z = z0; z <= z1; z += 4) {
                            for (int y = lowY; y <= highY; y += 4) {
                                world.setBiome(x, y, z, biome);
                            }
                        }
                    }
                    world.refreshChunk(cx, cz);
                }
                if (index >= chunks.size()) {
                    cancel();
                    applied = appliedAfter;
                    saveState();
                    working = false;
                    plugin.getLogger().info("[SeasonalSnow] Biome update finished (" + chunks.size() + " chunks).");
                }
            }
        }.runTaskTimer(plugin, 1L, 1L);
    }

    private void saveState() {
        YamlConfiguration state = new YamlConfiguration();
        state.set("applied", applied);
        try {
            state.save(stateFile);
        } catch (IOException e) {
            plugin.getLogger().warning("[SeasonalSnow] Could not save state: " + e.getMessage());
        }
    }

    /** No snow layers or ice ever form in the hub world, in or out of season. */
    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onBlockForm(BlockFormEvent event) {
        if (!blockSnowAndIce) return;
        if (!event.getBlock().getWorld().getName().equals(worldName)) return;
        Material type = event.getNewState().getType();
        if (type == Material.SNOW || type == Material.ICE || type == Material.SNOW_BLOCK) {
            event.setCancelled(true);
        }
    }
}
