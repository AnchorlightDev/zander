package dev.anchorlight.zander.hub.portal;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PortalDestinationTest {
    @Test
    void serverDestinationExposesServerId() {
        PortalDestination destination = new ServerPortalDestination("survival");
        assertInstanceOf(ServerPortalDestination.class, destination);
        assertEquals("survival", ((ServerPortalDestination) destination).serverId());
    }

    @Test
    void locationDestinationExposesCoordinates() {
        PortalDestination destination = new LocationPortalDestination("world", 0.5, 129.0, 0.5, 180f, 0f);
        assertInstanceOf(LocationPortalDestination.class, destination);
        LocationPortalDestination location = (LocationPortalDestination) destination;
        assertEquals("world", location.world());
        assertEquals(0.5, location.x());
        assertEquals(180f, location.yaw());
    }

    @Test
    void sealedInterfaceExhaustiveSwitchCoversBothTypes() {
        PortalDestination destination = new ServerPortalDestination("survival");
        String result = switch (destination) {
            case ServerPortalDestination server -> "server:" + server.serverId();
            case LocationPortalDestination location -> "location:" + location.world();
        };
        assertEquals("server:survival", result);
    }
}
