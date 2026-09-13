package dev.anchorlight.zander.pgm.gui;

import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.rating.MapRatingService;

import java.util.List;

/**
 * "Rate this Map" menu — five star slots (1-5), wired straight to the same
 * {@link MapRatingService#submit} used by {@code /maprate}, so participant
 * gating and the rating window are enforced identically either way.
 */
public class MapRatingMenu extends Menu {

    public MapRatingMenu(ZanderPGMPlugin plugin, String mapName) {
        super("Rate " + trim(mapName), 9);
        for (int i = 1; i <= 5; i++) {
            int slot = 1 + i; // slots 2-6
            int stars = i;
            setItem(slot, starItem(stars), event -> {
                Player player = (Player) event.getWhoClicked();
                MapRatingService.Result result = plugin.ratings().submit(player, stars, null);
                player.sendMessage(message(result, stars));
                if (result == MapRatingService.Result.OK || result == MapRatingService.Result.UPDATED) {
                    player.closeInventory();
                }
            });
        }
    }

    private static String trim(String mapName) {
        String name = mapName == null ? "this map" : mapName;
        return name.length() > 24 ? name.substring(0, 24) : name;
    }

    private ItemStack starItem(int stars) {
        ItemStack item = new ItemStack(Material.NETHER_STAR, stars);
        ItemMeta meta = item.getItemMeta();
        if (meta != null) {
            meta.setDisplayName("§e" + stars + " Star" + (stars == 1 ? "" : "s"));
            meta.setLore(List.of("§7Click to rate this map " + stars + "/5"));
            item.setItemMeta(meta);
        }
        return item;
    }

    private String message(MapRatingService.Result result, int rating) {
        return switch (result) {
            case OK -> "§aThanks! You rated this map §f" + rating + "§a/5.";
            case UPDATED -> "§aYour rating was updated to §f" + rating + "§a/5.";
            case NO_SESSION -> "§cThere is no map to rate right now.";
            case WINDOW_CLOSED -> "§cThe rating window has closed.";
            case NOT_PARTICIPANT -> "§cOnly players who played the match can rate it.";
            case INVALID_RATING -> "§cRating must be between 1 and 5.";
            case NOT_RATED_YET -> "§cRate the map first.";
        };
    }
}
