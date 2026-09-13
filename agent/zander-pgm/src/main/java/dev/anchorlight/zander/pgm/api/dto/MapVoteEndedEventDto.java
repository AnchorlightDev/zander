package dev.anchorlight.zander.pgm.api.dto;

import java.util.Map;

public class MapVoteEndedEventDto extends BridgeEvent {
    public String voteId;
    public String winningMapKey;
    public String winningMapName;
    public Map<String, Integer> tally;

    public MapVoteEndedEventDto() {
        super("MAP_VOTE_ENDED");
    }
}
