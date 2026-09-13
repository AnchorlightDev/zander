package org.modularsoft.zander.waterfall;

import com.google.common.io.ByteStreams;
import net.md_5.bungee.config.Configuration;
import net.md_5.bungee.config.ConfigurationProvider;
import net.md_5.bungee.config.YamlConfiguration;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;

public class ConfigurationManager {
    private static ZanderProxyMain plugin = ZanderProxyMain.getInstance();

    private static Configuration config;

    public static void initConfig() {
        File dataFolder = plugin.getDataFolder();
        if (!dataFolder.exists()) if (!dataFolder.mkdirs()) plugin.getLogger().info("Failed to create configuration folder.");

        File configFile = new File(dataFolder, "config.yml");
        if (!configFile.exists()) {
            try {
                if (!configFile.createNewFile()) {
                    plugin.getLogger().info("Unable to create configuration folder.");
                }
                InputStream in = plugin.getClass().getClassLoader().getResourceAsStream("config.yml");
                FileOutputStream ou = new FileOutputStream(configFile);

                ByteStreams.copy(in, ou);
                ou.close();
                in.close();
            } catch (IOException e) {
                e.printStackTrace();
            }
        }

        try {
            ConfigurationProvider provider = ConfigurationProvider.getProvider(YamlConfiguration.class);
            config = provider.load(new File(dataFolder, "config.yml"));
            provider.save(config, new File(dataFolder, "config.yml"));
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public static Configuration getConfig() {
        if (config == null)
            initConfig();

        return config;
    }
}
