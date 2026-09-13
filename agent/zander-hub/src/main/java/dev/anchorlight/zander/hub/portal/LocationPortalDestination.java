package dev.anchorlight.zander.hub.portal;

/** Teleports the player to a fixed location within a local Hub world. */
public record LocationPortalDestination(String world, double x, double y, double z, float yaw, float pitch)
        implements PortalDestination {
}
