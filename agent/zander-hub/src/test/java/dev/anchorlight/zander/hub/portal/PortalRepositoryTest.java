package dev.anchorlight.zander.hub.portal;

import dev.anchorlight.stonelib.region.Cuboid;
import org.bukkit.configuration.file.YamlConfiguration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.file.Path;
import java.util.Map;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.*;

class PortalRepositoryTest {
    private static final Logger LOGGER = Logger.getLogger("PortalRepositoryTest");

    @Test
    void loadsValidServerAndLocationPortals(@TempDir Path tempDir) throws Exception {
        File file = tempDir.resolve("portals.yml").toFile();
        YamlConfiguration yaml = new YamlConfiguration();
        yaml.set("portals.survival.display-name", "Survival");
        yaml.set("portals.survival.enabled", true);
        yaml.set("portals.survival.region.world", "world");
        yaml.set("portals.survival.region.min.x", 10);
        yaml.set("portals.survival.region.min.y", 120);
        yaml.set("portals.survival.region.min.z", 5);
        yaml.set("portals.survival.region.max.x", 12);
        yaml.set("portals.survival.region.max.y", 124);
        yaml.set("portals.survival.region.max.z", 5);
        yaml.set("portals.survival.destination.type", "SERVER");
        yaml.set("portals.survival.destination.server", "survival");
        yaml.set("portals.survival.permission", null);
        yaml.set("portals.survival.cooldown-ms", 2000);
        yaml.set("portals.survival.sound", "ENTITY_ENDERMAN_TELEPORT");
        yaml.set("portals.survival.messages.success", "Sending...");
        yaml.set("portals.survival.messages.denied", "Denied.");
        yaml.save(file);

        PortalRepository repository = new PortalRepository(file, LOGGER, world -> true);
        Map<String, Portal> loaded = repository.load();

        assertEquals(1, loaded.size());
        Portal portal = loaded.get("survival");
        assertNotNull(portal);
        assertEquals("Survival", portal.displayName());
        assertInstanceOf(ServerPortalDestination.class, portal.destination());
    }

    @Test
    void skipsMalformedEntryButLoadsRest(@TempDir Path tempDir) throws Exception {
        File file = tempDir.resolve("portals.yml").toFile();
        YamlConfiguration yaml = new YamlConfiguration();
        // malformed: missing destination type
        yaml.set("portals.broken.display-name", "Broken");
        yaml.set("portals.broken.enabled", true);
        yaml.set("portals.broken.region.world", "world");
        yaml.set("portals.broken.region.min.x", 0);
        yaml.set("portals.broken.region.min.y", 0);
        yaml.set("portals.broken.region.min.z", 0);
        yaml.set("portals.broken.region.max.x", 1);
        yaml.set("portals.broken.region.max.y", 1);
        yaml.set("portals.broken.region.max.z", 1);
        yaml.set("portals.broken.messages.success", "s");
        yaml.set("portals.broken.messages.denied", "d");
        // valid one alongside it
        yaml.set("portals.good.display-name", "Good");
        yaml.set("portals.good.enabled", true);
        yaml.set("portals.good.region.world", "world");
        yaml.set("portals.good.region.min.x", 0);
        yaml.set("portals.good.region.min.y", 0);
        yaml.set("portals.good.region.min.z", 0);
        yaml.set("portals.good.region.max.x", 1);
        yaml.set("portals.good.region.max.y", 1);
        yaml.set("portals.good.region.max.z", 1);
        yaml.set("portals.good.destination.type", "LOCATION");
        yaml.set("portals.good.destination.world", "world");
        yaml.set("portals.good.destination.x", 0.5);
        yaml.set("portals.good.destination.y", 65.0);
        yaml.set("portals.good.destination.z", 0.5);
        yaml.set("portals.good.destination.yaw", 0.0);
        yaml.set("portals.good.destination.pitch", 0.0);
        yaml.set("portals.good.messages.success", "s");
        yaml.set("portals.good.messages.denied", "d");
        yaml.save(file);

        PortalRepository repository = new PortalRepository(file, LOGGER, world -> true);
        Map<String, Portal> loaded = repository.load();

        assertEquals(1, loaded.size());
        assertTrue(loaded.containsKey("good"));
        assertFalse(loaded.containsKey("broken"));
    }

    @Test
    void rejectsPortalWhoseWorldDoesNotExist(@TempDir Path tempDir) throws Exception {
        File file = tempDir.resolve("portals.yml").toFile();
        YamlConfiguration yaml = new YamlConfiguration();
        yaml.set("portals.ghost.display-name", "Ghost");
        yaml.set("portals.ghost.enabled", true);
        yaml.set("portals.ghost.region.world", "nonexistent");
        yaml.set("portals.ghost.region.min.x", 0);
        yaml.set("portals.ghost.region.min.y", 0);
        yaml.set("portals.ghost.region.min.z", 0);
        yaml.set("portals.ghost.region.max.x", 1);
        yaml.set("portals.ghost.region.max.y", 1);
        yaml.set("portals.ghost.region.max.z", 1);
        yaml.set("portals.ghost.destination.type", "SERVER");
        yaml.set("portals.ghost.destination.server", "survival");
        yaml.set("portals.ghost.messages.success", "s");
        yaml.set("portals.ghost.messages.denied", "d");
        yaml.save(file);

        PortalRepository repository = new PortalRepository(file, LOGGER, world -> false);
        Map<String, Portal> loaded = repository.load();

        assertTrue(loaded.isEmpty());
    }

    @Test
    void returnsEmptyMapWhenFileMissing(@TempDir Path tempDir) {
        File file = tempDir.resolve("portals.yml").toFile();
        PortalRepository repository = new PortalRepository(file, LOGGER, world -> true);
        assertTrue(repository.load().isEmpty());
    }

    @Test
    void saveThenLoadRoundTrips(@TempDir Path tempDir) {
        File file = tempDir.resolve("portals.yml").toFile();
        PortalRepository repository = new PortalRepository(file, LOGGER, world -> true);

        Portal portal = new Portal("info", "Information Centre", true,
                new Cuboid("world", -5, 128, 20, -3, 131, 22),
                new LocationPortalDestination("world", 0.5, 129, 0.5, 180f, 0f),
                null, 1500L, "ENTITY_ENDERMAN_TELEPORT", "Teleporting...", "You cannot use this portal.");

        repository.save(java.util.List.of(portal));
        assertTrue(file.exists());

        Map<String, Portal> reloaded = repository.load();
        assertEquals(1, reloaded.size());
        Portal roundTripped = reloaded.get("info");
        assertEquals(portal.displayName(), roundTripped.displayName());
        assertEquals(portal.region(), roundTripped.region());
        assertInstanceOf(LocationPortalDestination.class, roundTripped.destination());
    }
}
