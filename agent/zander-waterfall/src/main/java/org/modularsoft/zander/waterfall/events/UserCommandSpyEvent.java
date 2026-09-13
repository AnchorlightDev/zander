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
import org.modularsoft.zander.waterfall.model.discord.spy.DiscordCommandSpy;

public class UserCommandSpyEvent implements Listener {
    private ZanderProxyMain plugin = ZanderProxyMain.getInstance();

    @EventHandler
    public void UserChatEvent(ChatEvent event) {
        if (event.isCommand()) {
            String command = event.getMessage().substring(1); // Remove the leading slash
            ProxiedPlayer player = (ProxiedPlayer) event.getSender();

            // Excludes specific commands from being logged in both spy events.
            if (command.startsWith("msg") || command.startsWith("tell") || command.startsWith("w") || command.startsWith("message") || command.startsWith("r")) {
                return;
            }

            //
            // Command Spy API POST
            //
            try {
                DiscordCommandSpy commandSpy = DiscordCommandSpy.builder()
                        .username(player.getDisplayName())
                        .command(command)
                        .server(player.getServer().getInfo().getName())
                        .build();

                Request destroySessionReq = Request.builder()
                        .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/discord/spy/command")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                        .setRequestBody(commandSpy.toString())
                        .build();

                Response commandSpyRes = destroySessionReq.execute();
                plugin.getProxy().getConsole().sendMessage(new TextComponent("Response (" + commandSpyRes.getStatusCode() + "): " + commandSpyRes.getBody()));
            } catch (Exception e) {
                player.disconnect(new TextComponent("An error has occurred. Is the API down?"));
                System.out.println(e);
                return;
            }
        }
    }
}