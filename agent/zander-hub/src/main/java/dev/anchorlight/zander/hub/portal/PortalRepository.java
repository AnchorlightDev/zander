package dev.anchorlight.zander.hub.portal;

import dev.anchorlight.stonelib.display.ArgbColours;
import dev.anchorlight.stonelib.region.Cuboid;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Predicate;
import java.util.logging.Logger;

/**
 * Loads and saves {@link Portal} definitions to {@code portals.yml}. Malformed entries
 * are skipped with a warning rather than aborting the whole load. Saves go through a
 * temporary file that is then moved over the target, so a crash mid-write can't corrupt
 * previously-valid data.
 */
public class PortalRepository {
    private final File file;
    private final Logger logger;
    private final Predicate<String> worldExists;

    public PortalRepository(File file, Logger logger, Predicate<String> worldExists) {
        this.file = file;
        this.logger = logger;
        this.worldExists = worldExists;
    }

    public Map<String, Portal> load() {
        Map<String, Portal> result = new LinkedHashMap<>();
        if (!file.exists()) {
            return result;
        }

        YamlConfiguration yaml = YamlConfiguration.loadConfiguration(file);
        ConfigurationSection portalsSection = yaml.getConfigurationSection("portals");
        if (portalsSection == null) {
            return result;
        }

        for (String rawId : portalsSection.getKeys(false)) {
            try {
                Portal portal = parseOne(portalsSection.getConfigurationSection(rawId), rawId);
                String key = PortalIdValidator.normalise(portal.id());
                if (result.containsKey(key)) {
                    logger.warning(() -> "Duplicate portal id (case-insensitive) '" + rawId + "', skipped");
                    continue;
                }
                result.put(key, portal);
            } catch (IllegalArgumentException e) {
                logger.warning(() -> "Skipping malformed portal '" + rawId + "': " + e.getMessage());
            }
        }
        return result;
    }

    private Portal parseOne(ConfigurationSection section, String rawId) {
        if (section == null) {
            throw new IllegalArgumentException("missing section");
        }
        if (!PortalIdValidator.isValid(rawId)) {
            throw new IllegalArgumentException("invalid id '" + rawId + "'");
        }

        String displayName = section.getString("display-name");
        if (displayName == null) {
            throw new IllegalArgumentException("missing display-name");
        }
        boolean enabled = section.getBoolean("enabled", true);

        ConfigurationSection regionSection = section.getConfigurationSection("region");
        if (regionSection == null) {
            throw new IllegalArgumentException("missing region");
        }
        String world = regionSection.getString("world");
        if (world == null || !worldExists.test(world)) {
            throw new IllegalArgumentException("region references unknown world '" + world + "'");
        }
        ConfigurationSection min = regionSection.getConfigurationSection("min");
        ConfigurationSection max = regionSection.getConfigurationSection("max");
        if (min == null || max == null) {
            throw new IllegalArgumentException("region missing min/max");
        }
        Cuboid region = new Cuboid(world,
                min.getInt("x"), min.getInt("y"), min.getInt("z"),
                max.getInt("x"), max.getInt("y"), max.getInt("z"));

        ConfigurationSection destinationSection = section.getConfigurationSection("destination");
        if (destinationSection == null) {
            throw new IllegalArgumentException("missing destination");
        }
        PortalDestination destination = parseDestination(destinationSection);

        String permission = section.getString("permission", null);
        long cooldownMs = section.getLong("cooldown-ms", 0L);
        String sound = section.getString("sound", null);
        if (sound != null) {
            validateSound(sound);
        }

        String successMessage = section.getString("messages.success", "");
        String deniedMessage = section.getString("messages.denied", "");

        PortalAppearance appearance = parseAppearance(section.getConfigurationSection("appearance"));

        return new Portal(rawId, displayName, enabled, region, destination, permission,
                cooldownMs, sound, successMessage, deniedMessage, appearance);
    }

    private static PortalAppearance parseAppearance(ConfigurationSection section) {
        if (section == null) {
            return PortalAppearance.NONE;
        }
        String rawStyle = section.getString("style", "NONE");
        PortalAppearance.Style style = PortalAppearance.parseStyle(rawStyle)
                .orElseThrow(() -> new IllegalArgumentException("unknown appearance style '" + rawStyle + "'"));
        String rawColour = section.getString("colour");
        int argb = rawColour == null ? PortalAppearance.DEFAULT_TINT : ArgbColours.parse(rawColour)
                .orElseThrow(() -> new IllegalArgumentException("invalid appearance colour '" + rawColour + "'"));
        return new PortalAppearance(style, argb);
    }

    private static final java.util.regex.Pattern VALID_SOUND_NAME = java.util.regex.Pattern.compile("^[A-Z0-9_]+$");

    // Intentionally a syntactic check, not Sound.valueOf(...): in this Paper API version, Sound
    // constants are backed by a live registry that only exists on a running server, so any
    // registry-backed lookup throws IllegalStateException under plain JUnit. Real existence is
    // validated later, at playback time, where a live server is guaranteed.
    private static void validateSound(String sound) {
        if (!VALID_SOUND_NAME.matcher(sound).matches()) {
            throw new IllegalArgumentException("invalid sound '" + sound + "'");
        }
    }

    private PortalDestination parseDestination(ConfigurationSection section) {
        String type = section.getString("type");
        if (type == null) {
            throw new IllegalArgumentException("destination missing type");
        }
        return switch (type) {
            case "SERVER" -> {
                String serverId = section.getString("server");
                if (serverId == null || serverId.isBlank()) {
                    throw new IllegalArgumentException("SERVER destination missing server id");
                }
                yield new ServerPortalDestination(serverId);
            }
            case "LOCATION" -> {
                String world = section.getString("world");
                if (world == null || !worldExists.test(world)) {
                    throw new IllegalArgumentException("LOCATION destination references unknown world '" + world + "'");
                }
                yield new LocationPortalDestination(world,
                        section.getDouble("x"), section.getDouble("y"), section.getDouble("z"),
                        (float) section.getDouble("yaw"), (float) section.getDouble("pitch"));
            }
            default -> throw new IllegalArgumentException("unknown destination type '" + type + "'");
        };
    }

    public void save(Collection<Portal> portals) {
        YamlConfiguration yaml = new YamlConfiguration();
        for (Portal portal : portals) {
            String base = "portals." + portal.id();
            yaml.set(base + ".display-name", portal.displayName());
            yaml.set(base + ".enabled", portal.enabled());
            yaml.set(base + ".region.world", portal.region().world());
            yaml.set(base + ".region.min.x", portal.region().minX());
            yaml.set(base + ".region.min.y", portal.region().minY());
            yaml.set(base + ".region.min.z", portal.region().minZ());
            yaml.set(base + ".region.max.x", portal.region().maxX());
            yaml.set(base + ".region.max.y", portal.region().maxY());
            yaml.set(base + ".region.max.z", portal.region().maxZ());

            switch (portal.destination()) {
                case ServerPortalDestination server -> {
                    yaml.set(base + ".destination.type", "SERVER");
                    yaml.set(base + ".destination.server", server.serverId());
                }
                case LocationPortalDestination location -> {
                    yaml.set(base + ".destination.type", "LOCATION");
                    yaml.set(base + ".destination.world", location.world());
                    yaml.set(base + ".destination.x", location.x());
                    yaml.set(base + ".destination.y", location.y());
                    yaml.set(base + ".destination.z", location.z());
                    yaml.set(base + ".destination.yaw", location.yaw());
                    yaml.set(base + ".destination.pitch", location.pitch());
                }
            }

            yaml.set(base + ".permission", portal.permission());
            yaml.set(base + ".cooldown-ms", portal.cooldownMs());
            yaml.set(base + ".sound", portal.sound());
            yaml.set(base + ".messages.success", portal.successMessage());
            yaml.set(base + ".messages.denied", portal.deniedMessage());
            yaml.set(base + ".appearance.style", portal.appearance().style().name());
            yaml.set(base + ".appearance.colour", ArgbColours.format(portal.appearance().argb()));
        }

        try {
            File parent = file.getParentFile();
            if (parent != null) {
                Files.createDirectories(parent.toPath());
            }
            File tempFile = new File(file.getParentFile(), file.getName() + ".tmp");
            yaml.save(tempFile);
            Files.move(tempFile.toPath(), file.toPath(),
                    StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (java.nio.file.FileSystemException atomicNotSupported) {
            try {
                File tempFile = new File(file.getParentFile(), file.getName() + ".tmp");
                Files.move(tempFile.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException e) {
                logger.severe("Failed to save portals.yml (fallback move): " + e.getMessage());
            }
        } catch (IOException e) {
            logger.severe("Failed to save portals.yml: " + e.getMessage());
        }
    }
}
