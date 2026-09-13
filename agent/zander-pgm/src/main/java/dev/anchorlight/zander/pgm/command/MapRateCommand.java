package dev.anchorlight.zander.pgm.command;

import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import dev.anchorlight.zander.pgm.ZanderPGMPlugin;
import dev.anchorlight.zander.pgm.rating.MapRatingService;

/** {@code /maprate <1-5> [feedback]} — rate the last map, optionally with feedback. */
public class MapRateCommand implements CommandExecutor {

    private final ZanderPGMPlugin plugin;

    public MapRateCommand(ZanderPGMPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage("Only players can rate maps.");
            return true;
        }
        if (args.length < 1) {
            player.sendMessage("§cUsage: /maprate <1-5> [feedback]");
            return true;
        }
        int rating;
        try {
            rating = Integer.parseInt(args[0]);
        } catch (NumberFormatException e) {
            player.sendMessage("§cRating must be a number from 1 to 5.");
            return true;
        }
        String feedback = args.length > 1
                ? String.join(" ", java.util.Arrays.copyOfRange(args, 1, args.length))
                : null;

        MapRatingService.Result result = plugin.ratings().submit(player, rating, feedback);
        player.sendMessage(message(result, rating));
        return true;
    }

    private String message(MapRatingService.Result result, int rating) {
        return switch (result) {
            case OK -> "§aThanks! You rated this map §f" + rating + "§a/5.";
            case UPDATED -> "§aYour rating was updated to §f" + rating + "§a/5.";
            case NO_SESSION -> "§cThere is no map to rate right now.";
            case WINDOW_CLOSED -> "§cThe rating window has closed.";
            case NOT_PARTICIPANT -> "§cOnly players who played the match can rate it.";
            case INVALID_RATING -> "§cRating must be between 1 and 5.";
            case NOT_RATED_YET -> "§cRate the map first with /maprate <1-5>.";
        };
    }
}
