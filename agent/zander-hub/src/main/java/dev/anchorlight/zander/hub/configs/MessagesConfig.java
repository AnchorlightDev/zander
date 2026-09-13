package dev.anchorlight.zander.hub.configs;

import java.io.File;
import java.io.IOException;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.plugin.java.JavaPlugin;
import static dev.anchorlight.stonelib.ConfigValidator.isValidPlayerString;
import static dev.anchorlight.stonelib.ConfigValidator.validateConfig;

/**
 * Manages server messages for the plugin, and their persistence.
 * Handles loading, validation, and uniformity of managed data.
 */
public class MessagesConfig {
    private final JavaPlugin plugin;

    private TextComponent textCompJoinTemplate;
    private TextComponent textCompLeaveTemplate;

    public MessagesConfig(JavaPlugin plugin) {
        this.plugin = plugin;
    }

    /// Configure the player join/leave messages.
    /// Validates the entries in server 'config.yml' with fallback.
    public void setupJoinLeave() {
        FileConfiguration config = plugin.getConfig();

        String fallbackJoin = "&7%p% <default join message>";
        String fallbackLeave = "&7%p% <default leave message>";
        String fieldJoin = "messages.join";
        String fieldLeave = "messages.leave";

        validateConfig(plugin, config, fieldJoin, isValidPlayerString, fallbackJoin,
                template -> this.textCompJoinTemplate = template);
        validateConfig(plugin, config, fieldLeave, isValidPlayerString, fallbackLeave,
                template -> this.textCompLeaveTemplate = template);

        plugin.saveConfig(); // * save to external 'config.yml'

        String textLegacyJoin = config.getString(fieldJoin);
        String textLegacyLeave = config.getString(fieldLeave);

        if (this.plugin.getServer().getPluginManager().isPluginEnabled("PremiumVanish")) {
            updatePremiumVanish(textLegacyJoin, textLegacyLeave);
            dev.anchorlight.zander.hub.utils.PremiumVanishBridge.reloadConfig();
        }
    }

    /// Get join message for `playerName`
    public Component getPlayerJoin(Component playerName) {
        return insertPlayerName(this.textCompJoinTemplate, playerName);
    }

    /// Get leave message for `playerName`
    public Component getPlayerLeave(Component playerName) {
        return insertPlayerName(this.textCompLeaveTemplate, playerName);
    }

    /// Insert component `playerName` into `template`
    private Component insertPlayerName(TextComponent template, Component playerName) {
        if (template == null)
            throw new IllegalStateException("Missing setup, first run 'MessagesConfig.setupJoinLeave'");
        return template.replaceText(builder -> builder
                .match("%p%") // * validation ensured single %p%
                .replacement(playerName)); // * style is handled as expected
    }

    /// Replace join/leave messages in PremiumVanish 'messages.yml' file.
    private void updatePremiumVanish(String textLegacyJoin, String textLegacyLeave) {
        File pvYML = new File(this.plugin.getDataFolder().getParentFile(), "PremiumVanish/messages.yml");
        if (pvYML.exists()) {
            YamlConfiguration config = YamlConfiguration.loadConfiguration(pvYML);
            config.set("Messages.DiscordSRVFakeJoin", textLegacyJoin);
            config.set("Messages.DiscordSRVFakeQuit", textLegacyLeave);
            config.set("Messages.ReappearMessage", textLegacyJoin);
            config.set("Messages.VanishMessage", textLegacyLeave);
            try {
                config.save(pvYML);
            } catch (IOException e) {
                this.plugin.getLogger().warning("Failed to update PremiumVanish messages.yml");
            }
        }
    }
}
