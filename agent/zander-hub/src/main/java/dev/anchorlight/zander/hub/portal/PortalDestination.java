package dev.anchorlight.zander.hub.portal;

/** A portal's configured destination: either a Velocity backend server or a local Hub location. */
public sealed interface PortalDestination permits ServerPortalDestination, LocationPortalDestination {
}
