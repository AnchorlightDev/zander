package dev.anchorlight.zander.pgm.voting;

import java.util.UUID;

/** A player's current vote in an active {@link MapVote}. */
public class MapVoteCast {
    public final UUID uuid;
    public final String username;
    public int optionNumber;
    public int weight;
    public String source;

    public MapVoteCast(UUID uuid, String username, int optionNumber, int weight, String source) {
        this.uuid = uuid;
        this.username = username;
        this.optionNumber = optionNumber;
        this.weight = weight;
        this.source = source;
    }
}
