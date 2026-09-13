package dev.anchorlight.zander.velocity.events.session;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.DisconnectEvent;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.model.discord.DiscordLeave;
import dev.anchorlight.zander.velocity.model.session.SessionDestroy;

public class UserOnDisconnect {
    @Subscribe
    public void UserDisconnectEvent(DisconnectEvent event) {
        Player player = event.getPlayer();
        String BaseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String APIKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

        boolean isConnected = isConnected(ZanderVelocityMain.getProxy(), player.getUsername());
        if (isConnected) return;

        ZanderVelocityMain.getProxy().getScheduler().buildTask(ZanderVelocityMain.getInstance(), () -> {
            //
            // Destroy Session API POST
            //
            try {
                SessionDestroy destroySession = SessionDestroy.builder()
                        .uuid(player.getUniqueId())
                        .build();

                Request destroySessionReq = Request.builder()
                        .setURL(BaseAPIURL + "/session/destroy")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", APIKey)
                        .setRequestBody(destroySession.toString())
                        .build();

                Response destroySessionRes = destroySessionReq.execute();
                ZanderVelocityMain.getLogger().info("Response (" + destroySessionRes.getStatusCode() + "): " + destroySessionRes.getBody());
            } catch (Exception e) {
                ZanderVelocityMain.getLogger().error("Error destroying session for " + player.getUsername(), e);
            }

            //
            // Send Discord API POST for disconnect message
            //
            try {
                DiscordLeave leave = DiscordLeave.builder()
                        .username(player.getUsername())
                        .build();

                Request discordLeaveReq = Request.builder()
                        .setURL(BaseAPIURL + "/discord/leave")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", APIKey)
                        .setRequestBody(leave.toString())
                        .build();

                Response discordLeaveRes = discordLeaveReq.execute();
                ZanderVelocityMain.getLogger().info("Response (" + discordLeaveRes.getStatusCode() + "): " + discordLeaveRes.getBody());
            } catch (Exception e) {
                ZanderVelocityMain.getLogger().error("Error sending Discord leave notification for " + player.getUsername(), e);
            }
        }).schedule();
    }

    public static boolean isConnected(ProxyServer proxy, String playerName) {
        Player player = proxy.getPlayer(playerName).orElse(null);
        return player != null;
    }
}
