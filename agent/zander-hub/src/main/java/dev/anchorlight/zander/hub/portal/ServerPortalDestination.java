package dev.anchorlight.zander.hub.portal;

/** Sends the player through the Zander proxy bridge to the named Velocity backend server. */
public record ServerPortalDestination(String serverId) implements PortalDestination {
}
