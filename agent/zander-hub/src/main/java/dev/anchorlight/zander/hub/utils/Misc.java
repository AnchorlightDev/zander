package dev.anchorlight.zander.hub.utils;

import org.bukkit.Bukkit;
import org.bukkit.entity.Player;

/**
 * Utility class providing miscellaneous functions.
 */
public final class Misc {

    private Misc() {
        throw new IllegalStateException("Utility class shouldn't be instantiated");
    }

    public static boolean isVanish(Player player) {
        if (player == null || !Bukkit.getPluginManager().isPluginEnabled("PremiumVanish"))
            return false;
        return PremiumVanishBridge.isInvisible(player);
    }
}
