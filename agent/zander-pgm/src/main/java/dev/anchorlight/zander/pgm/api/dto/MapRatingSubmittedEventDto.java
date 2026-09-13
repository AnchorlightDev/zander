package dev.anchorlight.zander.pgm.api.dto;

public class MapRatingSubmittedEventDto extends BridgeEvent {
    public String matchId;
    public String mapKey;
    public String mapName;
    public String uuid;
    public String username;
    public int rating;
    public String feedback;
    public boolean updated;

    public MapRatingSubmittedEventDto() {
        super("MAP_RATING_SUBMITTED");
    }
}
