package dev.anchorlight.zander.pgm.util;

import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Thin wrapper around the plugin {@link Logger} that adds throttling helpers so
 * background retry loops cannot spam the console.
 */
public final class SafeLogger {

    private final Logger logger;
    private final boolean debug;

    public SafeLogger(Logger logger, boolean debug) {
        this.logger = logger;
        this.debug = debug;
    }

    /** The underlying plugin logger, for libraries that log directly. */
    public Logger logger() {
        return logger;
    }

    public boolean isDebug() {
        return debug;
    }

    public void info(String message) {
        logger.info(message);
    }

    public void warn(String message) {
        logger.warning(message);
    }

    public void error(String message, Throwable t) {
        logger.log(Level.SEVERE, message, t);
    }

    public void debug(String message) {
        if (debug) {
            logger.info("[debug] " + message);
        }
    }
}
