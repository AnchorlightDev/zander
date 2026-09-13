package dev.anchorlight.zander.velocity.events.session;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.player.ServerConnectedEvent;
import com.velocitypowered.api.proxy.Player;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.model.discord.DiscordSwitch;
import dev.anchorlight.zander.velocity.model.session.SessionSwitch;
import org.slf4j.Logger;

import java.util.UUID;

public class UserOnSwitch {
    private static final Logger logger = ZanderVelocityMain.getLogger();

    @Subscribe
    public void onServerConnect(ServerConnectedEvent event) {
        Player player = event.getPlayer();
        String username = player.getUsername();
        UUID playerUUID = player.getUniqueId();
        String server = event.getServer().getServerInfo().getName();
        String BaseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String APIKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

        ZanderVelocityMain.getProxy().getScheduler().buildTask(ZanderVelocityMain.getInstance(), () -> {
            // Handle Session Switch API
            try {
                SessionSwitch switchSession = SessionSwitch.builder()
                        .uuid(playerUUID)
                        .server(server)
                        .build();

                Request switchSessionReq = Request.builder()
                        .setURL(BaseAPIURL + "/session/switch")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", APIKey)
                        .setRequestBody(switchSession.toString())
                        .build();

                switchSessionReq.execute();
            } catch (Exception e) {
                logger.error("Error during Session Switch API request for player {}", username, e);
            }

            // Handle Discord Switch API
            try {
                DiscordSwitch discordSwitch = DiscordSwitch.builder()
                        .username(username)
                        .server(server)
                        .build();

                Request discordSwitchReq = Request.builder()
                        .setURL(BaseAPIURL + "/discord/switch")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", APIKey)
                        .setRequestBody(discordSwitch.toString())
                        .build();

                discordSwitchReq.execute();
            } catch (Exception e) {
                logger.error("Error during Discord Switch API request for player {}", username, e);
            }
        }).schedule();
    }
}
