package dev.anchorlight.zander.pgm.config;

import org.bukkit.configuration.file.YamlConfiguration;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ConfigLoaderTest {

    @Test
    void loadsApiToken() {
        YamlConfiguration yaml = new YamlConfiguration();
        yaml.set("api.token", "mixed-token");

        ZanderPGMConfig config = ConfigLoader.load(yaml);

        assertEquals("mixed-token", config.token);
    }
}
