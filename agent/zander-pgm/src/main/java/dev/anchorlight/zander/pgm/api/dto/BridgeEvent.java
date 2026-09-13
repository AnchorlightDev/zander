package dev.anchorlight.zander.pgm.api.dto;

import dev.anchorlight.zander.pgm.util.TimeUtil;

/**
 * Base class for every payload sent to zander-web. The transport envelope
 * ({@link #serverId}, {@link #pluginVersion}, {@link #timestamp}) is stamped by
 * the API client before sending; subclasses add their own fields which Gson
 * serialises alongside these.
 */
public abstract class BridgeEvent {

    /** Event type discriminator, e.g. {@code MATCH_STARTED}. */
    public final String type;

    /** Set by the API client at send time. */
    public String serverId;
    public String pluginVersion;
    public long timestamp = TimeUtil.now();
    public String isoTimestamp = TimeUtil.isoNow();

    protected BridgeEvent(String type) {
        this.type = type;
    }
}
