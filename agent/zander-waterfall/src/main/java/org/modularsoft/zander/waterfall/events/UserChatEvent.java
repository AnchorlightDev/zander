package org.modularsoft.zander.waterfall.events;

import com.jayway.jsonpath.JsonPath;
import org.modularsoft.zander.waterfall.ConfigurationManager;
import org.modularsoft.zander.waterfall.ZanderProxyMain;
import org.modularsoft.zander.waterfall.model.Filter;
import io.github.ModularEnigma.Request;
import io.github.ModularEnigma.Response;
import net.md_5.bungee.api.ChatColor;
import net.md_5.bungee.api.chat.TextComponent;
import net.md_5.bungee.api.connection.ProxiedPlayer;
import net.md_5.bungee.api.event.ChatEvent;
import net.md_5.bungee.api.plugin.Listener;
import net.md_5.bungee.event.EventHandler;
import org.modularsoft.zander.waterfall.model.discord.DiscordChat;

import static com.jayway.jsonpath.Criteria.where;

public class UserChatEvent implements Listener {
    private ZanderProxyMain plugin = ZanderProxyMain.getInstance();

    @EventHandler
    public void UserChatEvent(ChatEvent event) {
        ProxiedPlayer player = (ProxiedPlayer) event.getSender();

        // Filter out commands.
        if (event.getMessage().startsWith("/")) return;

        // Check chat for blocked content
        try {
            Filter phrase = Filter.builder()
                    .content(event.getMessage().toString())
                    .build();

            Request phraseReq = Request.builder()
                    .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/filter")
                    .setMethod(Request.Method.POST)
                    .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                    .setRequestBody(phrase.toString())
                    .build();

            Response phraseRes = phraseReq.execute();
            String phraseJson = phraseRes.getBody();

            Boolean success = JsonPath.parse(phraseJson).read("$.success");
            String phraseCaughtMessage = JsonPath.read(phraseJson, "$.message");

            plugin.getProxy().getConsole().sendMessage(new TextComponent("[FILTER] Response (" + phraseRes.getStatusCode() + "): " + phraseRes.getBody()));

            if (!success) {
                player.sendMessage(new TextComponent(ChatColor.RED + phraseCaughtMessage));
                event.setCancelled(true);
            } else {
                DiscordChat chat = DiscordChat.builder()
                        .username(((ProxiedPlayer) event.getSender()).getDisplayName())
                        .server(((ProxiedPlayer) event.getSender()).getServer().getInfo().getName())
                        .content(event.getMessage().toString())
                        .build();

                Request discordChatReq = Request.builder()
                        .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/discord/chat")
                        .setMethod(Request.Method.POST)
                        .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                        .setRequestBody(chat.toString())
                        .build();

                Response discordChatReqRes = discordChatReq.execute();
                plugin.getProxy().getConsole().sendMessage(new TextComponent("Response (" + discordChatReqRes.getStatusCode() + "): " + discordChatReqRes.getBody()));
            }
        } catch (Exception e) {
            player.sendMessage(new TextComponent(ChatColor.YELLOW + "The chat filter could not be reached at this time, there maybe an issue with the API."));
            System.out.println(e);
        }
    }

}
