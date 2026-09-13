package dev.anchorlight.zander.hub.portal;

import dev.anchorlight.stonelib.region.RegionIndex;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Runtime-authoritative view of portals: mediates between the persisted store
 * ({@link PortalRepository}) and the lookup structure used by movement detection
 * ({@link RegionIndex<Portal>}). All mutation methods persist and re-index before returning.
 */
public class PortalService {
    /// Notified after a portal is added, changed, or removed ({@code before} or {@code after} is null).
    public interface ChangeListener {
        void onChange(Portal before, Portal after);
    }

    private final PortalRepository repository;
    private final RegionIndex<Portal> index;
    private Map<String, Portal> portals;
    private ChangeListener changeListener = (before, after) -> { };

    public PortalService(PortalRepository repository, RegionIndex<Portal> index) {
        this.repository = repository;
        this.index = index;
        this.portals = repository.load();
        this.index.rebuild(this.portals.values());
    }

    public void setChangeListener(ChangeListener changeListener) {
        this.changeListener = Objects.requireNonNull(changeListener, "changeListener");
    }

    public void reload() {
        Map<String, Portal> previous = this.portals;
        this.portals = repository.load();
        this.index.rebuild(this.portals.values());

        Set<String> keys = new LinkedHashSet<>(previous.keySet());
        keys.addAll(this.portals.keySet());
        for (String key : keys) {
            Portal before = previous.get(key);
            Portal after = this.portals.get(key);
            if (!Objects.equals(before, after)) {
                changeListener.onChange(before, after);
            }
        }
    }

    public Collection<Portal> all() {
        return this.portals.values();
    }

    public Optional<Portal> find(String id) {
        return Optional.ofNullable(this.portals.get(PortalIdValidator.normalise(id)));
    }

    public void put(Portal portal) {
        Portal before = this.portals.put(PortalIdValidator.normalise(portal.id()), portal);
        persistAndReindex();
        if (!portal.equals(before)) {
            changeListener.onChange(before, portal);
        }
    }

    public boolean delete(String id) {
        Portal removed = this.portals.remove(PortalIdValidator.normalise(id));
        if (removed == null) {
            return false;
        }
        persistAndReindex();
        changeListener.onChange(removed, null);
        return true;
    }

    public void setEnabled(String id, boolean enabled) {
        Portal existing = this.portals.get(PortalIdValidator.normalise(id));
        if (existing == null) {
            throw new IllegalArgumentException("No such portal: " + id);
        }
        put(new Portal(existing.id(), existing.displayName(), enabled, existing.region(), existing.destination(),
                existing.permission(), existing.cooldownMs(), existing.sound(),
                existing.successMessage(), existing.deniedMessage(), existing.appearance()));
    }

    private void persistAndReindex() {
        Map<String, Portal> snapshot = new LinkedHashMap<>(this.portals);
        this.portals = snapshot;
        repository.save(snapshot.values());
        index.rebuild(snapshot.values());
    }
}
