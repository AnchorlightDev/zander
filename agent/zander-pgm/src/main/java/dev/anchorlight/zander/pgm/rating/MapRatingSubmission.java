package dev.anchorlight.zander.pgm.rating;

import java.util.UUID;

/** A single player's rating (and optional feedback) for a match's map. */
public class MapRatingSubmission {
    public final UUID uuid;
    public final String username;
    public int rating;
    public String feedback;
    public long timestamp;

    public MapRatingSubmission(UUID uuid, String username, int rating, String feedback) {
        this.uuid = uuid;
        this.username = username;
        this.rating = rating;
        this.feedback = feedback;
        this.timestamp = System.currentTimeMillis();
    }
}
