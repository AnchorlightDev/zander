package dev.anchorlight.zander.pgm.gui;

import com.google.gson.JsonObject;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.pgm.MatchIdentityService;
import dev.anchorlight.zander.pgm.util.JsonUtil;

import java.util.List;

/**
 * Self-service "spend a Map Token" menu for spectators. Balance is read from
 * and spends are posted to the same web-side ledger the dashboard/store use
 * (see ZanderApiClient#getMapTokens / #requestMapToken) — the plugin never
 * maintains its own copy of this balance.
 */
public class MapTokenMenu extends Menu {

    private static final int BALANCE_SLOT = 4;
    private static final int NOMINATE_SLOT = 10;
    private static final int SET_NEXT_SLOT = 12;
    private static final int SPONSOR_SLOT = 14;

    public MapTokenMenu(ZanderPGMPlugin plugin, Player player, int balance) {
        super("Map Tokens (" + balance + ")", 18);

        setItem(BALANCE_SLOT, infoItem(Material.SUNFLOWER, "§eYour Balance: §f" + balance + " token(s)",
                "§7Earned via the store or admin grants.",
                "§7Spend one below to influence the next map."), null);

        MatchIdentityService.Identity id = plugin.identity().current();
        String mapKey = id != null ? id.mapKey : null;
        String mapName = id != null ? id.mapName : null;

        if (mapKey == null) {
            setItem(NOMINATE_SLOT, infoItem(Material.BARRIER, "§cNo active match",
                    "§7There's no map loaded right now."), null);
        } else {
            setItem(NOMINATE_SLOT, actionItem(Material.PAPER, "§aNominate " + mapName,
                    "§7Add this map to the next vote."), e -> spend(plugin, (Player) e.getWhoClicked(), mapKey, "nominate"));
            setItem(SET_NEXT_SLOT, actionItem(Material.CLOCK, "§aSet " + mapName + " as next",
                    "§7Skip voting — play this map next."), e -> spend(plugin, (Player) e.getWhoClicked(), mapKey, "set_next"));
            setItem(SPONSOR_SLOT, actionItem(Material.GOLD_INGOT, "§aSponsor " + mapName,
                    "§7Guarantee this map wins the next vote."), e -> spend(plugin, (Player) e.getWhoClicked(), mapKey, "sponsor"));
        }
    }

    private void spend(ZanderPGMPlugin plugin, Player player, String mapKey, String actionType) {
        player.closeInventory();
        player.sendMessage("§7Submitting your Map Token request...");
        plugin.api().requestMapToken(player.getUniqueId().toString(), player.getName(), mapKey, actionType)
                .thenAccept(body -> Bukkit.getScheduler().runTask(plugin, () -> handleResult(player, body)));
    }

    private void handleResult(Player player, String body) {
        if (body == null) {
            player.sendMessage("§cCouldn't reach the server — try again in a moment.");
            return;
        }
        try {
            JsonObject json = JsonUtil.gson().fromJson(body, JsonObject.class);
            boolean success = json.has("success") && json.get("success").getAsBoolean();
            if (success) {
                player.sendMessage("§aMap Token request submitted!");
            } else {
                String message = json.has("message") ? json.get("message").getAsString() : "Request failed.";
                player.sendMessage("§c" + message);
            }
        } catch (Exception e) {
            player.sendMessage("§cUnexpected response from the server.");
        }
    }

    private ItemStack infoItem(Material material, String title, String... lore) {
        ItemStack item = new ItemStack(material);
        ItemMeta meta = item.getItemMeta();
        if (meta != null) {
            meta.setDisplayName(title);
            meta.setLore(List.of(lore));
            item.setItemMeta(meta);
        }
        return item;
    }

    private ItemStack actionItem(Material material, String title, String... lore) {
        return infoItem(material, title, lore);
    }
}
