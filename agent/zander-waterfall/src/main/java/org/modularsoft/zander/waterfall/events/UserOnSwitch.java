package org.modularsoft.zander.waterfall.events;

import io.github.ModularEnigma.Request;
import io.github.ModularEnigma.Response;
import net.md_5.bungee.api.chat.TextComponent;
import net.md_5.bungee.api.connection.ProxiedPlayer;
import net.md_5.bungee.api.event.ServerConnectedEvent;
import net.md_5.bungee.api.plugin.Listener;
import net.md_5.bungee.event.EventHandler;
import org.modularsoft.zander.waterfall.ConfigurationManager;
import org.modularsoft.zander.waterfall.ZanderProxyMain;
import org.modularsoft.zander.waterfall.model.discord.DiscordSwitch;
import org.modularsoft.zander.waterfall.model.session.SessionSwitch;

import java.util.UUID;

public class UserOnSwitch implements Listener {
    private ZanderProxyMain plugin = ZanderProxyMain.getInstance();

    @EventHandler
    public void onServerConnect(ServerConnectedEvent event) {
        ProxiedPlayer player = event.getPlayer();
        String username = player.getDisplayName();
        UUID playerUUID = player.getUniqueId();
        String server = event.getServer().getInfo().getName();

        try {
            //
            // Switch Session API POST
            //
            SessionSwitch switchSession = SessionSwitch.builder()
                    .uuid(playerUUID)
                    .server(server)
                    .build();

            Request switchSessionReq = Request.builder()
                    .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/session/switch")
                    .setMethod(Request.Method.POST)
                    .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                    .setRequestBody(switchSession.toString())
                    .build();

            Response switchSessionRes = switchSessionReq.execute();
            plugin.getProxy().getConsole().sendMessage(new TextComponent("Response (" + switchSessionRes.getStatusCode() + "): " + switchSessionRes.getBody()));
        } catch (Exception e) {
            player.disconnect(new TextComponent("An error has occurred. Is the API down?"));
            System.out.println(e);
        }

        try {
            //
            // Discord Switch API POST
            //
            DiscordSwitch discordSwitch = DiscordSwitch.builder()
                    .username(username)
                    .server(server)
                    .build();

            Request req = Request.builder()
                    .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/discord/switch")
                    .setMethod(Request.Method.POST)
                    .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                    .setRequestBody(discordSwitch.toString())
                    .build();

            Response res = req.execute();
            plugin.getProxy().getConsole().sendMessage(new TextComponent("Response (" + res.getStatusCode() + "): " + res.getBody()));
        } catch (Exception e) {
            player.disconnect(new TextComponent("An error has occurred. Is the API down?"));
            System.out.println(e);
        }
    }
}
