package dev.anchorlight.zander.hub.portal;

import org.junit.jupiter.api.Test;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

class PortalSessionManagerTest {
    @Test
    void cooldownBlocksImmediateRetrigger() {
        PortalSessionManager sessions = new PortalSessionManager();
        UUID player = UUID.randomUUID();
        sessions.markTriggered(player, "survival", 1000L, 2000L);
        assertTrue(sessions.isOnCooldown(player, "survival", 1500L));
        assertFalse(sessions.isOnCooldown(player, "survival", 3001L));
    }

    @Test
    void cooldownIsPerPortal() {
        PortalSessionManager sessions = new PortalSessionManager();
        UUID player = UUID.randomUUID();
        sessions.markTriggered(player, "survival", 1000L, 2000L);
        assertFalse(sessions.isOnCooldown(player, "events", 1500L));
    }

    @Test
    void loopSuppressionExpires() {
        PortalSessionManager sessions = new PortalSessionManager();
        UUID player = UUID.randomUUID();
        sessions.suppressUntil(player, 1000L);
        assertTrue(sessions.isSuppressed(player, 999L));
        assertFalse(sessions.isSuppressed(player, 1000L));
    }

    @Test
    void connectPendingIsExclusiveUntilCleared() {
        PortalSessionManager sessions = new PortalSessionManager();
        UUID player = UUID.randomUUID();
        assertTrue(sessions.tryMarkConnectPending(player));
        assertFalse(sessions.tryMarkConnectPending(player));
        sessions.clearConnectPending(player);
        assertTrue(sessions.tryMarkConnectPending(player));
    }

    @Test
    void clearRemovesAllState() {
        PortalSessionManager sessions = new PortalSessionManager();
        UUID player = UUID.randomUUID();
        sessions.markTriggered(player, "survival", 1000L, 2000L);
        sessions.suppressUntil(player, 5000L);
        sessions.tryMarkConnectPending(player);
        sessions.clear(player);
        assertFalse(sessions.isOnCooldown(player, "survival", 1500L));
        assertFalse(sessions.isSuppressed(player, 1500L));
        assertTrue(sessions.tryMarkConnectPending(player));
    }
}
