package dev.anchorlight.zander.pgm.api.dto;

import java.util.List;

public class MapRatingPromptedEventDto extends BridgeEvent {
    public String matchId;
    public String mapKey;
    public String mapName;
    public int ratingWindowSeconds;
    public List<String> participants;

    public MapRatingPromptedEventDto() {
        super("MAP_RATING_PROMPTED");
    }
}
