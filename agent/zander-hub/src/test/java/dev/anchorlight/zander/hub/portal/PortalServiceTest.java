package dev.anchorlight.zander.hub.portal;

import dev.anchorlight.stonelib.region.Cuboid;
import dev.anchorlight.stonelib.region.RegionIndex;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.file.Path;
import java.util.Optional;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.*;

class PortalServiceTest {
    private PortalService newService(Path tempDir) {
        File file = tempDir.resolve("portals.yml").toFile();
        PortalRepository repository = new PortalRepository(file, Logger.getLogger("test"), world -> true);
        return new PortalService(repository, new RegionIndex<>(Portal::region));
    }

    private Portal samplePortal(String id) {
        return new Portal(id, id, true, new Cuboid("world", 0, 60, 0, 1, 61, 1),
                new ServerPortalDestination("survival"), null, 0L, null, "s", "d");
    }

    @Test
    void putThenFindIsCaseInsensitive(@TempDir Path tempDir) {
        PortalService service = newService(tempDir);
        service.put(samplePortal("Survival"));

        Optional<Portal> found = service.find("SURVIVAL");
        assertTrue(found.isPresent());
        assertEquals("Survival", found.get().id());
    }

    @Test
    void deleteRemovesPortal(@TempDir Path tempDir) {
        PortalService service = newService(tempDir);
        service.put(samplePortal("survival"));
        assertTrue(service.delete("survival"));
        assertTrue(service.find("survival").isEmpty());
    }

    @Test
    void deleteReturnsFalseForUnknownId(@TempDir Path tempDir) {
        PortalService service = newService(tempDir);
        assertFalse(service.delete("nope"));
    }

    @Test
    void setEnabledTogglesState(@TempDir Path tempDir) {
        PortalService service = newService(tempDir);
        service.put(samplePortal("survival"));
        service.setEnabled("survival", false);
        assertFalse(service.find("survival").orElseThrow().enabled());
    }

    @Test
    void reloadReflectsPersistedData(@TempDir Path tempDir) {
        PortalService service = newService(tempDir);
        service.put(samplePortal("survival"));

        PortalService second = newService(tempDir);
        second.reload();
        assertTrue(second.find("survival").isPresent());
    }

    @Test
    void putUpdatesSpatialIndexImmediately(@TempDir Path tempDir) {
        PortalService service = newService(tempDir);
        service.put(samplePortal("survival"));
        assertEquals(1, service.all().size());
    }
}
