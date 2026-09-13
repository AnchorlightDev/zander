package dev.anchorlight.zander.pgm.api.dto;

public class MapVoteCancelledEventDto extends BridgeEvent {
    public String voteId;
    public String reason;

    public MapVoteCancelledEventDto() {
        super("MAP_VOTE_CANCELLED");
    }
}
