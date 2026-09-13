package dev.anchorlight.zander.pgm.api.dto;

import java.util.HashMap;
import java.util.Map;

public class LiveFeedEventDto extends BridgeEvent {
    public String feedType;
    public String message;
    public String matchId;
    public String mapKey;
    public Map<String, Object> data = new HashMap<>();

    public LiveFeedEventDto() {
        super("LIVE_FEED_EVENT");
    }

    public LiveFeedEventDto(String feedType, String message) {
        this();
        this.feedType = feedType;
        this.message = message;
    }
}
