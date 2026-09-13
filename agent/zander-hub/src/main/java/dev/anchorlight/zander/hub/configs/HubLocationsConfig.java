package dev.anchorlight.zander.hub.configs;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;
import static dev.anchorlight.stonelib.ConfigValidator.isValidDouble;
import static dev.anchorlight.stonelib.ConfigValidator.isValidPitch;
import static dev.anchorlight.stonelib.ConfigValidator.isValidWorld;
import static dev.anchorlight.stonelib.ConfigValidator.isValidYaw;
import static dev.anchorlight.stonelib.ConfigValidator.validateConfig;

/**
 * Manages hub locations for the plugin, and their persistence.
 * Handles loading, validation, and access to managed data.
 */
public class HubLocationsConfig {
    private final JavaPlugin plugin;

    private Location locationSpawn;
    // future? private Location locationParkour;

    public HubLocationsConfig(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    /// Configure the hub spawn location.
    /// Validates the entries in server 'config.yml' with fallback.
    public void setupSpawn() {
        FileConfiguration config = plugin.getConfig();

        // * access server's primary world (guaranteed by Bukkit to exist)
        Location defaultSpawn = Bukkit.getServer().getWorlds().get(0).getSpawnLocation();

        String fieldWorld = "hub.world";
        String fieldX = "hub.x";
        String fieldY = "hub.y";
        String fieldZ = "hub.z";
        String fieldPitch = "hub.pitch";
        String fieldYaw = "hub.yaw";

        validateConfig(plugin, config, fieldWorld, isValidWorld, defaultSpawn.getWorld().getName());
        validateConfig(plugin, config, fieldX, isValidDouble, defaultSpawn.getX());
        validateConfig(plugin, config, fieldY, isValidDouble, defaultSpawn.getY());
        validateConfig(plugin, config, fieldZ, isValidDouble, defaultSpawn.getZ());
        validateConfig(plugin, config, fieldPitch, isValidPitch, defaultSpawn.getPitch());
        validateConfig(plugin, config, fieldYaw, isValidYaw, defaultSpawn.getYaw());

        plugin.saveConfig(); // * save to external 'config.yml'

        World hubWorld = Bukkit.getWorld(config.getString(fieldWorld));
        double hubX = config.getDouble(fieldX);
        double hubY = config.getDouble(fieldY);
        double hubZ = config.getDouble(fieldZ);
        float hubYaw = (float) config.getDouble(fieldYaw);
        float hubPitch = (float) config.getDouble(fieldPitch);
        this.locationSpawn = new Location(hubWorld, hubX, hubY, hubZ, hubYaw, hubPitch);
    }

    /// Retrieve the hub spawn location.
    public Location getSpawn() {
        if (this.locationSpawn == null)
            throw new IllegalStateException("Missing setup, first run 'HubLocationsConfig.setupSpawn'");
        return this.locationSpawn.clone();
    }
}
