package dev.anchorlight.zander.addon.hologram;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;

import java.io.File;
import java.io.IOException;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.logging.Logger;

/** Stores placement anchors locally; message content remains managed by the web dashboard. */
public final class HologramRepository {
    private final File file;
    private final Logger logger;

    public HologramRepository(File file, Logger logger) {
        this.file = file;
        this.logger = logger;
    }

    public Map<String, PlacedHologram> load() {
        Map<String, PlacedHologram> result = new LinkedHashMap<>();
        File source = file.exists() ? file : legacyHubFile();
        if (source == null || !source.exists()) return result;
        YamlConfiguration yaml = YamlConfiguration.loadConfiguration(source);
        ConfigurationSection section = yaml.getConfigurationSection("holograms");
        if (section == null) return result;
        for (String name : section.getKeys(false)) {
            try {
                ConfigurationSection entry = section.getConfigurationSection(name);
                if (entry == null) continue;
                String worldName = entry.getString("world");
                World world = worldName == null ? null : Bukkit.getWorld(worldName);
                String group = entry.getString("group", "default");
                if (world == null || group.isBlank()) {
                    logger.warning("Skipping hologram '" + name + "': missing world or group");
                    continue;
                }
                Location location = new Location(world, entry.getDouble("x"), entry.getDouble("y"),
                        entry.getDouble("z"), (float) entry.getDouble("yaw"), (float) entry.getDouble("pitch"));
                result.put(name.toLowerCase(java.util.Locale.ROOT), new PlacedHologram(name, group, location));
            } catch (RuntimeException e) {
                logger.warning("Skipping malformed hologram '" + name + "': " + e.getMessage());
            }
        }
        if (!file.exists() && !result.isEmpty()) {
            save(result.values());
            logger.info("Migrated " + result.size() + " hologram placement(s) from zander-hub to zander-addon.");
        }
        return result;
    }

    private File legacyHubFile() {
        File pluginDirectory = file.getParentFile();
        File pluginsDirectory = pluginDirectory == null ? null : pluginDirectory.getParentFile();
        return pluginsDirectory == null ? null : new File(new File(pluginsDirectory, "zander-hub"), "holograms.yml");
    }

    public void save(Collection<PlacedHologram> holograms) {
        YamlConfiguration yaml = new YamlConfiguration();
        for (PlacedHologram hologram : holograms) {
            Location location = hologram.location();
            String key = "holograms." + hologram.name();
            yaml.set(key + ".group", hologram.group());
            yaml.set(key + ".world", location.getWorld().getName());
            yaml.set(key + ".x", location.getX());
            yaml.set(key + ".y", location.getY());
            yaml.set(key + ".z", location.getZ());
            yaml.set(key + ".yaw", location.getYaw());
            yaml.set(key + ".pitch", location.getPitch());
        }
        try {
            File parent = file.getParentFile();
            if (parent != null) parent.mkdirs();
            yaml.save(file);
        } catch (IOException e) {
            throw new IllegalStateException("Could not save holograms.yml", e);
        }
    }
}
