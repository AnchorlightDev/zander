package org.modularsoft.zander.waterfall.events;

import org.modularsoft.zander.waterfall.ConfigurationManager;
import org.modularsoft.zander.waterfall.ZanderProxyMain;
import org.modularsoft.zander.waterfall.model.discord.DiscordJoin;
import org.modularsoft.zander.waterfall.model.session.SessionCreate;
import org.modularsoft.zander.waterfall.model.user.UserCreation;
import io.github.ModularEnigma.Request;
import io.github.ModularEnigma.Response;
import net.md_5.bungee.api.chat.TextComponent;
import net.md_5.bungee.api.connection.ProxiedPlayer;
import net.md_5.bungee.api.event.PostLoginEvent;
import net.md_5.bungee.api.plugin.Listener;
import net.md_5.bungee.event.EventHandler;
import net.md_5.bungee.event.EventPriority;

public class UserOnLogin implements Listener {
    private ZanderProxyMain plugin = ZanderProxyMain.getInstance();

    @EventHandler(priority = EventPriority.HIGH)
    public void UserLoginEvent (PostLoginEvent event) {
        ProxiedPlayer player = event.getPlayer();

        try {
            //
            // Send User Creation API POST for new user
            //
            UserCreation createUser = UserCreation.builder()
                    .uuid(player.getUniqueId())
                    .username(player.getDisplayName())
                    .build();

            Request createUserReq = Request.builder()
                    .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/user/create")
                    .setMethod(Request.Method.POST)
                    .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                    .setRequestBody(createUser.toString())
                    .build();

            Response createUserRes = createUserReq.execute();
            plugin.getProxy().getConsole().sendMessage(new TextComponent("Response (" + createUserRes.getStatusCode() + "): " + createUserRes.getBody()));

            try {
                //
                // Start Session API POST
                //
                SessionCreate createSession = SessionCreate.builder()
                        .uuid(player.getUniqueId())
                        .ipAddress(player.getAddress().getAddress().getHostAddress())
                        .build();

                Request createSessionReq = Request.builder()
                        .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/session/create")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                        .setRequestBody(createSession.toString())
                        .build();

                Response createSessionRes = createSessionReq.execute();
                String json = createSessionRes.getBody();

                System.out.println(json);

                plugin.getProxy().getConsole().sendMessage(new TextComponent("Response (" + createSessionRes.getStatusCode() + "): " + createSessionRes.getBody()));

                // Send Discord API POST for join message
                DiscordJoin join = DiscordJoin.builder()
                        .username(player.getDisplayName())
                        .build();

                Request discordJoinReq = Request.builder()
                        .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/discord/join")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                        .setRequestBody(join.toString())
                        .build();

                Response discordJoinRes = discordJoinReq.execute();
                plugin.getProxy().getConsole().sendMessage(new TextComponent("Response (" + discordJoinRes.getStatusCode() + "): " + discordJoinRes.getBody()));
            } catch (Exception e) {
                player.disconnect(new TextComponent("An error has occurred. Is the API down?"));
                System.out.println(e);
                return;
            }
        } catch (Exception e) {
            player.disconnect(new TextComponent("An error has occurred. Is the API down?"));
            System.out.println(e);
            return;
        }
    }

}
