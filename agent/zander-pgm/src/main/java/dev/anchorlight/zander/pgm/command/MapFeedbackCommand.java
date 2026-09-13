package dev.anchorlight.zander.pgm.command;

import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.rating.MapRatingService;

/** {@code /mapfeedback <feedback>} — attach feedback to an existing rating. */
public class MapFeedbackCommand implements CommandExecutor {

    private final ZanderPGMPlugin plugin;

    public MapFeedbackCommand(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage("Only players can submit feedback.");
            return true;
        }
        if (args.length < 1) {
            player.sendMessage("§cUsage: /mapfeedback <feedback>");
            return true;
        }
        String feedback = String.join(" ", args);
        MapRatingService.Result result = plugin.ratings().submitFeedbackOnly(player, feedback);
        switch (result) {
            case UPDATED, OK -> player.sendMessage("§aThanks for your feedback!");
            case NO_SESSION -> player.sendMessage("§cThere is no map to give feedback on right now.");
            case WINDOW_CLOSED -> player.sendMessage("§cThe feedback window has closed.");
            case NOT_RATED_YET -> player.sendMessage("§cRate the map first with /maprate <1-5>.");
            default -> player.sendMessage("§cUnable to submit feedback.");
        }
        return true;
    }
}
