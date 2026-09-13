package dev.anchorlight.zander.pgm.api.dto;

import java.util.List;
import java.util.Map;

public class MapVoteStartedEventDto extends BridgeEvent {
    public String voteId;
    public int durationSeconds;
    public List<Map<String, Object>> options;

    public MapVoteStartedEventDto() {
        super("MAP_VOTE_STARTED");
    }
}
