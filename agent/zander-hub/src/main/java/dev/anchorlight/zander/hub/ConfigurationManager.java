package dev.anchorlight.zander.hub;

import java.io.File;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.configuration.file.YamlConfiguration;
import dev.anchorlight.zander.hub.configs.CompassConfig;
import dev.anchorlight.zander.hub.configs.DimensionsConfig;
import dev.anchorlight.zander.hub.configs.HubLocationsConfig;
import dev.anchorlight.zander.hub.configs.MessagesConfig;
import dev.anchorlight.zander.hub.configs.MiscConfig;

public final class ConfigurationManager {
    private static FileConfiguration welcomeFile;
    private static CompassConfig compassConfig;
    private static DimensionsConfig dimensionsConfig;
    private static HubLocationsConfig hubLocationsConfig;
    private static MessagesConfig messagesConfig;
    private static MiscConfig miscConfig;

    private ConfigurationManager() {
        throw new IllegalStateException("Utility class shouldn't be instantiated");
    }

    public static void setupHubLocationsConfig() {
        if (hubLocationsConfig != null)
            throw new IllegalStateException("Already setup, ensure there's a single call");
        hubLocationsConfig = new HubLocationsConfig(ZanderHubMain.plugin);
        hubLocationsConfig.setupSpawn();
        // future? hubLocationsConfig.setupParkour();
    }

    public static void setupMessagesConfig() {
        if (messagesConfig != null)
            throw new IllegalStateException("Already setup, ensure there's a single call");
        messagesConfig = new MessagesConfig(ZanderHubMain.plugin);
        messagesConfig.setupJoinLeave();
    }

    public static void setupMiscConfig() {
        if (miscConfig != null)
            throw new IllegalStateException("Already setup, ensure there's a single call");
        miscConfig = new MiscConfig(ZanderHubMain.plugin);
        miscConfig.setupSlotHubCompass();
        miscConfig.setupAlwaysFirstJoin();
    }

    public static void setupDimensionsConfig() {
        if (dimensionsConfig != null)
            throw new IllegalStateException("Already setup, ensure there's a single call");
        dimensionsConfig = new DimensionsConfig(ZanderHubMain.plugin);
        dimensionsConfig.setup();
    }

    public static void setupCompassConfig() {
        if (compassConfig != null)
            throw new IllegalStateException("Already setup, ensure there's a single call");
        compassConfig = new CompassConfig(ZanderHubMain.plugin);
        compassConfig.setupServers();
    }

    public static void setupWelcomeFile() {
        if (welcomeFile != null)
            throw new IllegalStateException("Already setup, ensure there's a single call");
        File dataFolder = ZanderHubMain.plugin.getDataFolder();
        File welcomeFileYML = new File(dataFolder, "welcome.yml");
        if (!welcomeFileYML.exists())
            ZanderHubMain.plugin.saveResource("welcome.yml", false);
        welcomeFile = YamlConfiguration.loadConfiguration(welcomeFileYML);
    }

    public static HubLocationsConfig getHubLocations() {
        if (hubLocationsConfig == null)
            throw new IllegalStateException("Missing setup, first run 'ConfigurationManager.setupHubLocationsConfig'");
        return hubLocationsConfig;
    }

    public static MessagesConfig getMessages() {
        if (messagesConfig == null)
            throw new IllegalStateException("Missing setup, first run 'ConfigurationManager.setupMessagesConfig'");
        return messagesConfig;
    }

    public static MiscConfig getMisc() {
        if (miscConfig == null)
            throw new IllegalStateException("Missing setup, first run 'ConfigurationManager.setupMiscConfig'");
        return miscConfig;
    }

    public static DimensionsConfig getDimensions() {
        if (dimensionsConfig == null)
            throw new IllegalStateException("Missing setup, first run 'ConfigurationManager.setupDimensionsConfig'");
        return dimensionsConfig;
    }

    public static CompassConfig getCompass() {
        if (compassConfig == null)
            throw new IllegalStateException("Missing setup, first run 'ConfigurationManager.setupCompassConfig'");
        return compassConfig;
    }

    public static FileConfiguration getWelcome() {
        if (welcomeFile == null)
            throw new IllegalStateException("Missing setup, first run 'ConfigurationManager.setupWelcomeFile'");
        return welcomeFile;
    }
}
