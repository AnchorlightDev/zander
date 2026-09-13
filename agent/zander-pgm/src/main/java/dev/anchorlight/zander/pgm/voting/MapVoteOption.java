package dev.anchorlight.zander.pgm.voting;

/** A single selectable map in a vote, with an optional token boost weight. */
public class MapVoteOption {
    public final int number;
    public final String mapKey;
    public final String mapName;
    public final String source; // ROTATION, RANDOM, FEATURED, TOKEN_NOMINATION, TOKEN_SPONSOR
    public int boostWeight;

    public MapVoteOption(int number, String mapKey, String mapName, String source) {
        this.number = number;
        this.mapKey = mapKey;
        this.mapName = mapName;
        this.source = source;
    }
}
