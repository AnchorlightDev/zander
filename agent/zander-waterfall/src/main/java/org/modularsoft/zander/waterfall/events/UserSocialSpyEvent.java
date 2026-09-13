package org.modularsoft.zander.waterfall.events;

import io.github.ModularEnigma.Request;
import io.github.ModularEnigma.Response;
import net.md_5.bungee.api.chat.TextComponent;
import net.md_5.bungee.api.connection.ProxiedPlayer;
import net.md_5.bungee.api.event.ChatEvent;
import net.md_5.bungee.api.plugin.Listener;
import net.md_5.bungee.event.EventHandler;
import org.modularsoft.zander.waterfall.ConfigurationManager;
import org.modularsoft.zander.waterfall.ZanderProxyMain;
import org.modularsoft.zander.waterfall.model.discord.spy.DiscordSocialSpy;

import java.util.Arrays;

public class UserSocialSpyEvent implements Listener {
    private ZanderProxyMain plugin = ZanderProxyMain.getInstance();

    @EventHandler
    public void UserChatEvent(ChatEvent event) {
        ProxiedPlayer player = (ProxiedPlayer) event.getSender();
        String command = event.getMessage().substring(1); // Remove the leading slash

        if (command.startsWith("msg") || command.startsWith("tell") || command.startsWith("w") || command.startsWith("message") || command.startsWith("r")) {
            String[] messageParts = event.getMessage().split(" ");
            String targetPlayer = messageParts[1];
            String directMessage = String.join(" ", Arrays.copyOfRange(messageParts, 2, messageParts.length));

            //
            // Social Spy API POST
            //
            try {
                DiscordSocialSpy socialSpy = DiscordSocialSpy.builder()
                        .usernameFrom(player.getDisplayName())
                        .usernameTo(targetPlayer)
                        .directMessage(directMessage)
                        .server(player.getServer().getInfo().getName())
                        .build();

                Request socialSpyReq = Request.builder()
                        .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/discord/spy/directMessage")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                        .setRequestBody(socialSpy.toString())
                        .build();

                Response socialSpyRes = socialSpyReq.execute();
                plugin.getProxy().getConsole().sendMessage(new TextComponent("Response (" + socialSpyRes.getStatusCode() + "): " + socialSpyRes.getBody()));
            } catch (Exception e) {
                player.disconnect(new TextComponent("An error has occurred. Is the API down?"));
                System.out.println(e);
                return;
            }
        }
    }
}