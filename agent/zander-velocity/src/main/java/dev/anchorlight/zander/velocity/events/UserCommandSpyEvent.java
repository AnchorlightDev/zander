package dev.anchorlight.zander.velocity.events;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.command.CommandExecuteEvent;
import com.velocitypowered.api.proxy.Player;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.model.discord.spy.DiscordCommandSpy;
import org.slf4j.Logger;

import java.util.Set;

public class UserCommandSpyEvent {

    private static final Logger logger = ZanderVelocityMain.getLogger();

    // Commands that carry private message content and must not be logged
    private static final Set<String> DM_COMMANDS = Set.of(
            "msg", "tell", "w", "message", "m", "whisper", "t", "r", "reply"
    );

    @Subscribe
    public void onPlayerCommand(CommandExecuteEvent event) {
        // Ensure the command source is a player
        if (!(event.getCommandSource() instanceof Player)) {
            return;
        }

        Player player = (Player) event.getCommandSource();
        String command = event.getCommand();

        // Extract the command name (first word) for exact matching
        String commandName = command.split(" ", 2)[0].toLowerCase();

        // Skip DM commands to avoid logging sensitive content
        if (DM_COMMANDS.contains(commandName)) {
            return;
        }

        String BaseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String APIKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));
        String server = player.getCurrentServer()
                .map(conn -> conn.getServer().getServerInfo().getName())
                .orElse("unknown");

        ZanderVelocityMain.getProxy().getScheduler().buildTask(ZanderVelocityMain.getInstance(), () -> {
            try {
                DiscordCommandSpy commandSpy = DiscordCommandSpy.builder()
                        .username(player.getUsername())
                        .command(command)
                        .server(server)
                        .build();

                Request commandSpyReq = Request.builder()
                        .setURL(BaseAPIURL + "/discord/spy/command")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", String.valueOf(APIKey))
                        .setRequestBody(commandSpy.toString())
                        .build();

                commandSpyReq.execute();
            } catch (Exception e) {
                logger.error("Error sending command spy event for player {}", player.getUsername(), e);
            }
        }).schedule();
    }

}
