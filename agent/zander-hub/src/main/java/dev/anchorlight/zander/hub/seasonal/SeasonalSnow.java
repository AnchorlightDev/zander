package dev.anchorlight.zander.hub.seasonal;

import io.papermc.paper.registry.RegistryAccess;
import io.papermc.paper.registry.RegistryKey;
import org.bukkit.Bukkit;
import org.bukkit.Chunk;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.block.Biome;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockFormEvent;
import org.bukkit.event.world.ChunkLoadEvent;
import org.bukkit.persistence.PersistentDataContainer;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;

import java.time.DateTimeException;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashSet;
import java.util.Set;

/**
 * Seasonal hub snow (config: seasonal-snow).
 *
 * During the configured months (December by default) every chunk of the hub
 * world is switched to a snowy biome and the world is kept raining, so the
 * client renders snowfall everywhere. Chunks are converted as they load (and
 * any already loaded when the season starts), so the whole world is covered
 * without needing to know its size. Each converted chunk remembers its original
 * biome in its own persistent data; when the season ends, chunks are restored
 * to that biome as they load. Snow layers and ice never form in the hub world.
 */
public class SeasonalSnow implements Listener {

    private static final long CHECK_INTERVAL_TICKS = 20L * 60 * 5; // 5 minutes
    private static final int WEATHER_DURATION_TICKS = 20 * 60 * 30; // refreshed well before it runs out
    private static final int CHUNKS_PER_TICK = 4;

    private final JavaPlugin plugin;
    private final NamespacedKey originalBiomeKey;

    private boolean enabled;
    private boolean force;
    private boolean blockSnowAndIce;
    private Set<Integer> months;
    private ZoneId zone;
    private String worldName;
    private int sampleY;
    private Biome snowBiome;
    private Biome fallbackBiome;

    /** Chunks waiting to be converted or restored, processed a few per tick. */
    private final Deque<long[]> queue = new ArrayDeque<>();
    private final Set<Long> queued = new HashSet<>();
    private boolean season;

    public SeasonalSnow(JavaPlugin plugin) {
        this.plugin = plugin;
        this.originalBiomeKey = new NamespacedKey(plugin, "snow_original_biome");
    }

    public void start() {
        loadConfig();
        season = inSeason();
        Bukkit.getScheduler().runTaskTimer(plugin, this::check, 40L, CHECK_INTERVAL_TICKS);
        Bukkit.getScheduler().runTaskTimer(plugin, this::drainQueue, 1L, 1L);
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
        // Height used to read a chunk's original biome before converting it.
        sampleY = (int) Math.floor(plugin.getConfig().getDouble("hub.y", 64));
        snowBiome = biome(c.getString("snow-biome", "minecraft:snowy_plains"), "snow-biome");
        fallbackBiome = biome(c.getString("normal-biome", "minecraft:plains"), "normal-biome");
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

    private World hubWorld() {
        return Bukkit.getWorld(worldName);
    }

    /** Periodic check: hold the weather and pick up season start/end. */
    private void check() {
        World world = hubWorld();
        if (world == null) return;

        boolean now = inSeason();
        if (now != season) {
            season = now;
            plugin.getLogger().info(now
                    ? "[SeasonalSnow] Season started, converting the hub world to snow."
                    : "[SeasonalSnow] Season over, restoring the hub world's biomes.");
            if (!now) {
                world.setStorm(false);
                world.setThundering(false);
            }
        }

        if (season) {
            // Re-applied every check so the natural weather timer never clears it.
            world.setStorm(true);
            world.setThundering(false);
            world.setWeatherDuration(WEATHER_DURATION_TICKS);
        }

        // Catch every loaded chunk that is in the wrong state for the season.
        Arrays.stream(world.getLoadedChunks()).forEach(this::queueIfNeeded);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onChunkLoad(ChunkLoadEvent event) {
        if (!event.getWorld().getName().equals(worldName)) return;
        queueIfNeeded(event.getChunk());
    }

    private void queueIfNeeded(Chunk chunk) {
        boolean converted = chunk.getPersistentDataContainer().has(originalBiomeKey, PersistentDataType.STRING);
        if (season == converted) return; // already right for the season
        if (season && snowBiome == null) return;
        long id = Chunk.getChunkKey(chunk.getX(), chunk.getZ());
        if (queued.add(id)) queue.add(new long[]{chunk.getX(), chunk.getZ()});
    }

    private void drainQueue() {
        World world = hubWorld();
        if (world == null || queue.isEmpty()) return;
        for (int n = 0; n < CHUNKS_PER_TICK && !queue.isEmpty(); n++) {
            long[] next = queue.poll();
            int cx = (int) next[0], cz = (int) next[1];
            queued.remove(Chunk.getChunkKey(cx, cz));
            if (!world.isChunkLoaded(cx, cz)) continue; // handled again when it next loads
            Chunk chunk = world.getChunkAt(cx, cz);
            PersistentDataContainer pdc = chunk.getPersistentDataContainer();
            boolean converted = pdc.has(originalBiomeKey, PersistentDataType.STRING);

            if (season && !converted) {
                int bx = cx << 4, bz = cz << 4;
                int y = Math.max(world.getMinHeight(), Math.min(world.getMaxHeight() - 1, sampleY));
                Biome original = world.getBiome(bx + 8, y, bz + 8);
                pdc.set(originalBiomeKey, PersistentDataType.STRING, original.getKey().toString());
                paint(world, cx, cz, snowBiome);
            } else if (!season && converted) {
                String id = pdc.get(originalBiomeKey, PersistentDataType.STRING);
                Biome original = biome(id, "stored original");
                if (original == null) original = fallbackBiome;
                if (original == null) continue;
                paint(world, cx, cz, original);
                pdc.remove(originalBiomeKey);
            }
        }
    }

    /** Set a whole chunk column to one biome and resend it to players. */
    private void paint(World world, int cx, int cz, Biome biome) {
        int bx = cx << 4, bz = cz << 4;
        int minY = world.getMinHeight(), maxY = world.getMaxHeight() - 1;
        // Biomes are stored per 4x4x4 cell, so one call per cell is enough.
        for (int x = bx; x < bx + 16; x += 4) {
            for (int z = bz; z < bz + 16; z += 4) {
                for (int y = minY; y <= maxY; y += 4) {
                    world.setBiome(x, y, z, biome);
                }
            }
        }
        world.refreshChunk(cx, cz);
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
