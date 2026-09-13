package dev.anchorlight.zander.hub.portal;

import org.bukkit.NamespacedKey;
import org.bukkit.Registry;
import org.bukkit.Sound;

import java.util.Locale;

/**
 * Sound lookup by name.
 *
 * Sound.valueOf(String) is deprecated and marked for removal: Sound is no
 * longer an enum but a registry-backed interface. Resolving through
 * Registry.SOUNDS keeps name-based configuration working without the
 * scheduled-for-deletion API.
 */
public final class PortalSounds {

    private PortalSounds() {
    }

    /**
     * Resolve a configured sound name, accepting either the enum-style
     * ENTITY_ENDERMAN_TELEPORT that existing configs use or a namespaced
     * minecraft:entity.enderman.teleport key.
     *
     * @return the sound, or null when the name matches nothing
     */
    public static Sound resolve(String name) {
        if (name == null || name.isBlank()) {
            return null;
        }

        String trimmed = name.trim();
        NamespacedKey key = trimmed.indexOf(':') >= 0
                ? NamespacedKey.fromString(trimmed.toLowerCase(Locale.ROOT))
                // ENTITY_ENDERMAN_TELEPORT -> entity.enderman.teleport
                : NamespacedKey.minecraft(trimmed.toLowerCase(Locale.ROOT).replace('_', '.'));

        return key == null ? null : Registry.SOUNDS.get(key);
    }

    /** True when the name resolves to a real sound. */
    public static boolean isValid(String name) {
        return resolve(name) != null;
    }
}
