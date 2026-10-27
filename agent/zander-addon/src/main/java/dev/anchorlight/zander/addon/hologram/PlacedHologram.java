package dev.anchorlight.zander.addon.hologram;

import org.bukkit.Location;

/** A named in-world anchor connected to a dashboard frame group. */
public record PlacedHologram(String name, String group, Location location) {
}
