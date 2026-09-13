package dev.anchorlight.zander.hub.portal;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Per-player runtime portal state: per-portal cooldown timestamps, post-teleport loop-suppression,
 * and in-flight connect-request tracking. Which portal a player is inside is tracked by StoneLib's
 * {@code RegionTracker}.
 * Keyed by player UUID; call {@link #clear(UUID)} on disconnect.
 */
public class PortalSessionManager {
    private final Map<UUID, Map<String, Long>> cooldownUntil = new ConcurrentHashMap<>();
    private final Map<UUID, Long> suppressedUntil = new ConcurrentHashMap<>();
    private final java.util.Set<UUID> connectPending = ConcurrentHashMap.newKeySet();

    public boolean isOnCooldown(UUID player, String portalId, long nowMs) {
        Map<String, Long> byPortal = cooldownUntil.get(player);
        if (byPortal == null) {
            return false;
        }
        Long until = byPortal.get(portalId);
        return until != null && nowMs < until;
    }

    public void markTriggered(UUID player, String portalId, long nowMs, long cooldownMs) {
        cooldownUntil.computeIfAbsent(player, key -> new ConcurrentHashMap<>()).put(portalId, nowMs + cooldownMs);
    }

    public boolean isSuppressed(UUID player, long nowMs) {
        Long until = suppressedUntil.get(player);
        return until != null && nowMs < until;
    }

    public void suppressUntil(UUID player, long untilMs) {
        suppressedUntil.put(player, untilMs);
    }

    public boolean tryMarkConnectPending(UUID player) {
        return connectPending.add(player);
    }

    public void clearConnectPending(UUID player) {
        connectPending.remove(player);
    }

    public void clear(UUID player) {
        cooldownUntil.remove(player);
        suppressedUntil.remove(player);
        connectPending.remove(player);
    }
}
