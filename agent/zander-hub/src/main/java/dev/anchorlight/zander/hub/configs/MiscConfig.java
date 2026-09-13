package dev.anchorlight.zander.hub.configs;

import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;
import static dev.anchorlight.stonelib.ConfigValidator.isValidBoolean;
import static dev.anchorlight.stonelib.ConfigValidator.isValidHotbarSlot;
import static dev.anchorlight.stonelib.ConfigValidator.validateConfig;

/**
 * Manages miscellaneous settings for the plugin, and their persistance.
 * Handles loading, validation, and access to managed data.
 */
public class MiscConfig {
    private final JavaPlugin plugin;

    private int slotHubCompass; // * default 0
    private boolean alwaysFirstJoin; // * default false

    public MiscConfig(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    /// Configure the inventory slot for the hub compass.
    /// Validates the entry in server 'config.yml' with fallback.
    public void setupSlotHubCompass() {
        FileConfiguration config = plugin.getConfig();
        int fallback = 4;
        String field = "misc.slot_hub_compass";
        validateConfig(plugin, config, field, isValidHotbarSlot, fallback);
        plugin.saveConfig(); // * save to external 'config.yml'
        this.slotHubCompass = config.getInt(field);
    }

    /// Configure the setting for "always trigger first join".
    /// Validates the entry in server 'config.yml' with fallback.
    public void setupAlwaysFirstJoin() {
        FileConfiguration config = plugin.getConfig();
        boolean fallback = false;
        String field = "misc.always_first_join";
        validateConfig(plugin, config, field, isValidBoolean, fallback);
        plugin.saveConfig(); // * save to external 'config.yml'
        this.alwaysFirstJoin = config.getBoolean(field);
    }

    /// Get the inventory slot for the hub compass.
    public int getSlotHubCompass() {
        return this.slotHubCompass;
    }

    /// Get the setting for "always trigger first join".
    public boolean getAlwaysFirstJoin() {
        return this.alwaysFirstJoin;
    }
}
