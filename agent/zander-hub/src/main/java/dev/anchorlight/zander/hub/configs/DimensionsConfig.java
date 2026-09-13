package dev.anchorlight.zander.hub.configs;

import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.plugin.java.JavaPlugin;
import static dev.anchorlight.stonelib.ConfigValidator.isValidBoolean;
import static dev.anchorlight.stonelib.ConfigValidator.validateConfig;

/**
 * Manages Nether/End dimension-blocking settings, and their persistence.
 * Handles loading, validation, and access to managed data.
 */
public class DimensionsConfig {
    private final JavaPlugin plugin;

    private boolean netherBlocked;
    private String netherMessage;
    private boolean netherAllowBypass;
    private boolean endBlocked;
    private String endMessage;
    private boolean endAllowBypass;

    public DimensionsConfig(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    /// Configure Nether/End dimension-blocking settings.
    /// Validates the entries in server 'config.yml' with fallback.
    public void setup() {
        FileConfiguration config = plugin.getConfig();

        validateConfig(plugin, config, "dimensions.nether.blocked", isValidBoolean, true);
        validateConfig(plugin, config, "dimensions.nether.allow-bypass", isValidBoolean, true);
        validateConfig(plugin, config, "dimensions.end.blocked", isValidBoolean, false);
        validateConfig(plugin, config, "dimensions.end.allow-bypass", isValidBoolean, true);

        if (!config.isString("dimensions.nether.message")) {
            config.set("dimensions.nether.message", "<red>The Nether is not available from the Hub.</red>");
        }
        if (!config.isString("dimensions.end.message")) {
            config.set("dimensions.end.message", "<red>The End is not available from the Hub.</red>");
        }

        plugin.saveConfig(); // * save to external 'config.yml'

        this.netherBlocked = config.getBoolean("dimensions.nether.blocked");
        this.netherMessage = config.getString("dimensions.nether.message");
        this.netherAllowBypass = config.getBoolean("dimensions.nether.allow-bypass");
        this.endBlocked = config.getBoolean("dimensions.end.blocked");
        this.endMessage = config.getString("dimensions.end.message");
        this.endAllowBypass = config.getBoolean("dimensions.end.allow-bypass");
    }

    public boolean isNetherBlocked() {
        return this.netherBlocked;
    }

    public String getNetherMessage() {
        return this.netherMessage;
    }

    public boolean isNetherBypassAllowed() {
        return this.netherAllowBypass;
    }

    public boolean isEndBlocked() {
        return this.endBlocked;
    }

    public String getEndMessage() {
        return this.endMessage;
    }

    public boolean isEndBypassAllowed() {
        return this.endAllowBypass;
    }
}
