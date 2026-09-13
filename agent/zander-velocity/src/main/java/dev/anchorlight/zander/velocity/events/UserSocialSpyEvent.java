package dev.anchorlight.zander.velocity.events;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.command.CommandExecuteEvent;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ServerConnection;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.model.discord.spy.DiscordSocialSpy;
import org.slf4j.Logger;

import java.util.Arrays;
import java.util.Optional;
import java.util.Set;

public class UserSocialSpyEvent {

    private static final Logger logger = ZanderVelocityMain.getLogger();

    // Exact command names that send a DM with an explicit target argument
    private static final Set<String> DM_COMMANDS = Set.of(
            "msg", "tell", "w", "message", "m", "whisper", "t"
    );

    @Subscribe
    public void onUserChatDMEvent(CommandExecuteEvent event) {
        // Ensure the command source is a player
        if (!(event.getCommandSource() instanceof Player)) {
            return;
        }

        Player player = (Player) event.getCommandSource();
        String command = event.getCommand();

        // Extract the command name (first word) and use exact matching
        String[] commandParts = command.split(" ");
        String commandName = commandParts[0].toLowerCase();

        // Only process DM commands that have a target argument
        if (!DM_COMMANDS.contains(commandName)) {
            return;
        }

        // Require at least: command + target + message
        if (commandParts.length < 3) {
            logger.warn("Invalid direct message format from player: {}", player.getUsername());
            return;
        }

        String targetPlayer = commandParts[1];
        String directMessage = String.join(" ", Arrays.copyOfRange(commandParts, 2, commandParts.length));

        // Ensure the player is connected to a server
        Optional<ServerConnection> currentServerOpt = player.getCurrentServer();
        if (currentServerOpt.isEmpty()) {
            logger.warn("Player {} is not connected to any server", player.getUsername());
            return;
        }

        String serverName = currentServerOpt.get().getServerInfo().getName();
        String BaseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String APIKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

        ZanderVelocityMain.getProxy().getScheduler().buildTask(ZanderVelocityMain.getInstance(), () -> {
            try {
                DiscordSocialSpy socialSpy = DiscordSocialSpy.builder()
                        .usernameFrom(player.getUsername())
                        .usernameTo(targetPlayer)
                        .directMessage(directMessage)
                        .server(serverName)
                        .build();

                Request socialSpyReq = Request.builder()
                        .setURL(BaseAPIURL + "/discord/spy/directMessage")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", APIKey)
                        .setRequestBody(socialSpy.toString())
                        .build();

                socialSpyReq.execute();
            } catch (Exception e) {
                logger.error("Error occurred while handling social spy request for player {}", player.getUsername(), e);
            }
        }).schedule();
    }

}
