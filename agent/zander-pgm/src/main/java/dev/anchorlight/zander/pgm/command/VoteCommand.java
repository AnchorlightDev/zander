package dev.anchorlight.zander.pgm.command;

import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;

/** {@code /vote <number>} — cast an in-game map vote. */
public class VoteCommand implements CommandExecutor {

    private final ZanderPGMPlugin plugin;

    public VoteCommand(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage("Only players can vote.");
            return true;
        }
        if (args.length < 1) {
            player.sendMessage("§cUsage: /vote <number>");
            return true;
        }
        int number;
        try {
            number = Integer.parseInt(args[0]);
        } catch (NumberFormatException e) {
            player.sendMessage("§cThat is not a number.");
            return true;
        }
        plugin.votes().cast(player, number);
        return true;
    }
}
