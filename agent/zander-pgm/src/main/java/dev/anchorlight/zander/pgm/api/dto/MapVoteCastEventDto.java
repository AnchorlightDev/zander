package dev.anchorlight.zander.pgm.api.dto;

public class MapVoteCastEventDto extends BridgeEvent {
    public String voteId;
    public String uuid;
    public String username;
    public String mapKey;
    public int weight;
    public String source; // IN_GAME, WEB, TOKEN_BOOST

    public MapVoteCastEventDto() {
        super("MAP_VOTE_CAST");
    }
}
