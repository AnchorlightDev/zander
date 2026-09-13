package dev.anchorlight.zander.hub.configs;

import org.bukkit.Material;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Manages the Navigation Compass' configured server entries, and their persistence.
 * Handles loading, validation, and access to managed data.
 */
public class CompassConfig {
    private final JavaPlugin plugin;

    private List<CompassServerEntry> servers = Collections.emptyList();

    public record CompassServerEntry(String id, Material material, String display, String lore) {
    }

    public CompassConfig(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    /// Configure the Navigation Compass' server entries.
    /// Validates each entry in server 'config.yml', skipping invalid ones with a warning.
    public void setupServers() {
        FileConfiguration config = plugin.getConfig();
        ConfigurationSection section = config.getConfigurationSection("compass.servers");
        List<CompassServerEntry> parsed = new ArrayList<>();

        if (section == null) {
            plugin.getLogger().warning("Missing 'compass.servers' in config.yml; Navigation Compass will show no servers.");
            this.servers = Collections.emptyList();
            return;
        }

        for (String id : section.getKeys(false)) {
            ConfigurationSection entry = section.getConfigurationSection(id);
            if (entry == null) {
                plugin.getLogger().warning(String.format("Invalid 'compass.servers.%s' entry in config.yml, skipped", id));
                continue;
            }

            String materialName = entry.getString("material");
            String display = entry.getString("display");
            String lore = entry.getString("lore");

            if (materialName == null || display == null || lore == null) {
                plugin.getLogger().warning(String.format(
                        "Incomplete 'compass.servers.%s' entry in config.yml (needs material, display, lore), skipped", id));
                continue;
            }

            Material material = Material.matchMaterial(materialName);
            if (material == null) {
                plugin.getLogger().warning(String.format(
                        "Invalid 'compass.servers.%s.material' value '%s' in config.yml, skipped", id, materialName));
                continue;
            }

            parsed.add(new CompassServerEntry(id, material, display, lore));
        }

        this.servers = Collections.unmodifiableList(parsed);
    }

    /// Retrieve the configured, valid Navigation Compass server entries.
    public List<CompassServerEntry> getServers() {
        return this.servers;
    }
}
