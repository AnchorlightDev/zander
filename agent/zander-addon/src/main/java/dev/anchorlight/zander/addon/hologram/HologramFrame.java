package dev.anchorlight.zander.addon.hologram;

/** One dashboard-authored message in a hologram group's rotation. */
public record HologramFrame(String group, String message, String link, String countdownTo,
        String countdownFinishedText) {
}
