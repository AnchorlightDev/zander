package dev.anchorlight.zander.pgm.util;

import java.time.Instant;

/** Small time helpers shared across the plugin. */
public final class TimeUtil {

    private TimeUtil() {
    }

    /** Current epoch milliseconds. */
    public static long now() {
        return System.currentTimeMillis();
    }

    /** ISO-8601 timestamp for the current instant. */
    public static String isoNow() {
        return Instant.now().toString();
    }

    /** ISO-8601 timestamp for the given epoch millis. */
    public static String iso(long epochMillis) {
        return Instant.ofEpochMilli(epochMillis).toString();
    }

    /** Format a duration in seconds as {@code MM:SS}. */
    public static String formatSeconds(long seconds) {
        long m = seconds / 60;
        long s = seconds % 60;
        return String.format("%02d:%02d", m, s);
    }
}
