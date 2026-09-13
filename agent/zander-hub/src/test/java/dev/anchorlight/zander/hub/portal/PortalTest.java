package dev.anchorlight.zander.hub.portal;

import dev.anchorlight.stonelib.region.Cuboid;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class PortalTest {
    private Cuboid region() {
        return new Cuboid("world", 10, 120, 5, 12, 124, 5);
    }

    private PortalDestination destination() {
        return new ServerPortalDestination("survival");
    }

    @Test
    void constructsWithValidId() {
        Portal portal = new Portal("survival", "Survival", true, region(), destination(),
                null, 2000L, "ENTITY_ENDERMAN_TELEPORT", "Sending...", "Denied.");
        assertEquals("survival", portal.id());
        assertEquals(2000L, portal.cooldownMs());
    }

    @Test
    void rejectsInvalidId() {
        assertThrows(IllegalArgumentException.class, () -> new Portal("bad id!", "Bad", true, region(),
                destination(), null, 0L, null, "s", "d"));
    }

    @Test
    void rejectsNegativeCooldown() {
        assertThrows(IllegalArgumentException.class, () -> new Portal("survival", "Survival", true, region(),
                destination(), null, -1L, null, "s", "d"));
    }

    @Test
    void allowsNullPermissionAndSound() {
        Portal portal = new Portal("survival", "Survival", true, region(), destination(), null, 0L, null, "s", "d");
        assertNull(portal.permission());
        assertNull(portal.sound());
    }
}
