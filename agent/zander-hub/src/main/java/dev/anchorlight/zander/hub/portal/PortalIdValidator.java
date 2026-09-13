package dev.anchorlight.zander.hub.portal;

import java.util.regex.Pattern;

/** Validates and normalises portal IDs, which are treated case-insensitively throughout the system. */
public final class PortalIdValidator {
    private static final Pattern VALID_ID = Pattern.compile("^[A-Za-z0-9_-]+$");

    private PortalIdValidator() {
        throw new IllegalStateException("Utility class shouldn't be instantiated");
    }

    public static boolean isValid(String id) {
        return id != null && !id.isEmpty() && VALID_ID.matcher(id).matches();
    }

    /** Lower-cases the id for use as a case-insensitive map key. Caller must validate first. */
    public static String normalise(String id) {
        return id.toLowerCase(java.util.Locale.ROOT);
    }
}
