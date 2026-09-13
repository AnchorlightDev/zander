package dev.anchorlight.zander.pgm.api.dto;

/**
 * Lifecycle event for a Map Token request. {@link #status} carries the specific
 * transition (RECEIVED, ACCEPTED, APPLIED, REJECTED, FAILED, REFUNDED) and the
 * concrete {@link BridgeEvent#type} mirrors it as MAP_REQUEST_*.
 */
public class MapTokenRequestEventDto extends BridgeEvent {
    public String requestId;
    public String uuid;
    public String username;
    public String mapKey;
    public String action; // NOMINATE, SET_NEXT, SPONSOR
    public int tokenCost;
    public String status;
    public String reason;

    public MapTokenRequestEventDto(String type) {
        super(type);
    }
}
