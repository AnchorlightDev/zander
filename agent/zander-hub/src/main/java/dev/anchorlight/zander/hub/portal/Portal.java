package dev.anchorlight.zander.hub.portal;

import dev.anchorlight.stonelib.region.Cuboid;

import java.util.Objects;

/**
 * An immutable, fully-validated custom portal: a cuboid region that, when entered,
 * sends the player to a server or a local location.
 */
public record Portal(String id, String displayName, boolean enabled, Cuboid region,
        PortalDestination destination, String permission, long cooldownMs, String sound,
        String successMessage, String deniedMessage, PortalAppearance appearance) {
    public Portal {
        if (!PortalIdValidator.isValid(id)) {
            throw new IllegalArgumentException("Invalid portal id: " + id);
        }
        Objects.requireNonNull(displayName, "displayName");
        Objects.requireNonNull(region, "region");
        Objects.requireNonNull(destination, "destination");
        Objects.requireNonNull(successMessage, "successMessage");
        Objects.requireNonNull(deniedMessage, "deniedMessage");
        if (cooldownMs < 0) {
            throw new IllegalArgumentException("cooldownMs must not be negative: " + cooldownMs);
        }
        if (appearance == null) {
            appearance = PortalAppearance.NONE;
        }
    }

    /// Creates an invisible portal (no rendered appearance).
    public Portal(String id, String displayName, boolean enabled, Cuboid region,
            PortalDestination destination, String permission, long cooldownMs, String sound,
            String successMessage, String deniedMessage) {
        this(id, displayName, enabled, region, destination, permission, cooldownMs, sound,
                successMessage, deniedMessage, PortalAppearance.NONE);
    }

    public Portal withAppearance(PortalAppearance newAppearance) {
        return new Portal(id, displayName, enabled, region, destination, permission, cooldownMs, sound,
                successMessage, deniedMessage, newAppearance);
    }
}
