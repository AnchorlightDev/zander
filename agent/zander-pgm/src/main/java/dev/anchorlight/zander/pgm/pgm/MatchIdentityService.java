package dev.anchorlight.zander.pgm.pgm;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Tracks the identity of the current PGM match (id, map key/name) as a stable
 * snapshot that other components can read from any thread.
 */
public class MatchIdentityService {

    public static final class Identity {
        public final String matchId;
        public final String mapKey;
        public final String mapName;
        public final String mapVersion;

        public Identity(String matchId, String mapKey, String mapName, String mapVersion) {
            this.matchId = matchId;
            this.mapKey = mapKey;
            this.mapName = mapName;
            this.mapVersion = mapVersion;
        }
    }

    private final AtomicReference<Identity> current = new AtomicReference<>();
    private final AtomicReference<Identity> last = new AtomicReference<>();

    /**
     * Derive and store identity from a PGM match object (main thread).
     * PGM's own match id is not globally unique across server restarts, so a
     * fresh UUID is minted per match instead of trusting {@code match.getId()}.
     */
    public Identity update(Object match) {
        Object map = PGMUtils.getMap(match);
        Identity id = new Identity(
                UUID.randomUUID().toString(),
                PGMUtils.mapId(map),
                PGMUtils.mapName(map),
                PGMUtils.mapVersion(map));
        current.set(id);
        return id;
    }

    public void clearCurrent() {
        Identity c = current.getAndSet(null);
        if (c != null) {
            last.set(c);
        }
    }

    public Identity current() {
        return current.get();
    }

    public Identity last() {
        Identity c = current.get();
        return c != null ? c : last.get();
    }
}
