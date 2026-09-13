package dev.anchorlight.zander.addon.service;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

public class FreezeService {
    private final Set<UUID> frozenPlayers = new HashSet<>();

    public boolean isFrozen(UUID uuid) {
        return frozenPlayers.contains(uuid);
    }

    public void setFrozen(UUID uuid, boolean frozen) {
        if (frozen) {
            frozenPlayers.add(uuid);
        } else {
            frozenPlayers.remove(uuid);
        }
    }

    public boolean toggleFreeze(UUID uuid) {
        if (isFrozen(uuid)) {
            setFrozen(uuid, false);
            return false;
        } else {
            setFrozen(uuid, true);
            return true;
        }
    }
}
