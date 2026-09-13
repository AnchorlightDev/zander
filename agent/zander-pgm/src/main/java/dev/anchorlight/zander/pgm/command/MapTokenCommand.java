package dev.anchorlight.zander.pgm.command;

import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.gui.MenuItems;

/** {@code /maptoken} — opens the self-service Map Token menu (same as right-clicking the item). */
public class MapTokenCommand implements CommandExecutor {

    private final ZanderPGMPlugin plugin;

    public MapTokenCommand(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage("Only players can use Map Tokens.");
            return true;
        }
        if (!plugin.cfg().mapTokensEnabled || !plugin.cfg().feature("mapTokens")) {
            player.sendMessage("§cMap Tokens are currently disabled.");
            return true;
        }
        MenuItems.openTokenMenu(plugin, player);
        return true;
    }
}
