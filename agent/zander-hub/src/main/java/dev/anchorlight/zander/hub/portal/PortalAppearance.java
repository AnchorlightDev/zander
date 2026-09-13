package dev.anchorlight.zander.hub.portal;

import dev.anchorlight.stonelib.display.ArgbColours;

import java.util.Locale;
import java.util.Objects;
import java.util.Optional;

/**
 * How a portal's region is drawn in the world. {@code NONE} leaves it invisible,
 * {@code NETHER} fills empty space with real nether portal blocks, and {@code TINT}
 * renders a translucent panel in {@link #argb()}. The colour is kept when switching
 * styles so an admin can toggle back to their previous tint.
 */
public record PortalAppearance(Style style, int argb) {
    public enum Style { NONE, NETHER, TINT }

    public static final int DEFAULT_TINT = ArgbColours.withDefaultAlpha(0x8932B8);
    public static final PortalAppearance NONE = new PortalAppearance(Style.NONE, DEFAULT_TINT);

    public PortalAppearance {
        Objects.requireNonNull(style, "style");
    }

    public PortalAppearance withStyle(Style newStyle) {
        return new PortalAppearance(newStyle, argb);
    }

    public static Optional<Style> parseStyle(String input) {
        if (input == null) {
            return Optional.empty();
        }
        try {
            return Optional.of(Style.valueOf(input.trim().toUpperCase(Locale.ROOT)));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }
}
