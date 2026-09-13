package dev.anchorlight.zander.velocity.events.session;

import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.connection.PostLoginEvent;
import com.velocitypowered.api.proxy.Player;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import dev.anchorlight.zander.velocity.model.discord.DiscordJoin;
import dev.anchorlight.zander.velocity.model.session.SessionCreate;
import dev.anchorlight.zander.velocity.model.user.UserCreation;

public class UserOnLogin {
    @Subscribe
    public void UserLoginEvent (PostLoginEvent event) {
        Player player = event.getPlayer();
        ZanderVelocityMain.getPrivateMessageService().updateNameCache(player.getUniqueId(), player.getUsername());

        ZanderVelocityMain.getProxy().getScheduler().buildTask(ZanderVelocityMain.getInstance(), () -> {
            String BaseAPIURL = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
            String APIKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));

            try {
                //
                // Send User Creation API POST for new user
                //
                UserCreation createUser = UserCreation.builder()
                        .uuid(player.getUniqueId())
                        .username(player.getUsername())
                        .build();

                Request createUserReq = Request.builder()
                        .setURL(BaseAPIURL + "/user/create")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", APIKey)
                        .setRequestBody(createUser.toString())
                        .build();

                Response createUserRes = createUserReq.execute();
                ZanderVelocityMain.getLogger().info("User creation response (" + createUserRes.getStatusCode() + "): " + createUserRes.getBody());

                //
                // Start Session API POST
                //
                SessionCreate createSession = SessionCreate.builder()
                        .uuid(player.getUniqueId())
                        .ipAddress(player.getRemoteAddress().getAddress().toString())
                        .build();

                Request createSessionReq = Request.builder()
                        .setURL(BaseAPIURL + "/session/create")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", APIKey)
                        .setRequestBody(createSession.toString())
                        .build();

                Response createSessionRes = createSessionReq.execute();
                ZanderVelocityMain.getLogger().info("Session creation response (" + createSessionRes.getStatusCode() + "): " + createSessionRes.getBody());

                // Send Discord API POST for join message
                DiscordJoin join = DiscordJoin.builder()
                        .username(player.getUsername())
                        .build();

                Request discordJoinReq = Request.builder()
                        .setURL(BaseAPIURL + "/discord/join")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", APIKey)
                        .setRequestBody(join.toString())
                        .build();

                Response discordJoinRes = discordJoinReq.execute();
                ZanderVelocityMain.getLogger().info("Discord join response (" + discordJoinRes.getStatusCode() + "): " + discordJoinRes.getBody());

            } catch (Exception e) {
                ZanderVelocityMain.getLogger().error("An error occurred during the async login process for " + player.getUsername(), e);
            }
        }).schedule();
    }
}
