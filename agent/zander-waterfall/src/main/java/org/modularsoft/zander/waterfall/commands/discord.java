package org.modularsoft.zander.waterfall.commands;

import com.jayway.jsonpath.JsonPath;
import org.modularsoft.zander.waterfall.ConfigurationManager;
import org.modularsoft.zander.waterfall.ZanderProxyMain;
import io.github.ModularEnigma.Request;
import io.github.ModularEnigma.Response;
import net.md_5.bungee.api.ChatColor;
import net.md_5.bungee.api.CommandSender;
import net.md_5.bungee.api.chat.ClickEvent;
import net.md_5.bungee.api.chat.TextComponent;
import net.md_5.bungee.api.connection.ProxiedPlayer;
import net.md_5.bungee.api.plugin.Command;

public class discord extends Command {

    private ZanderProxyMain plugin = ZanderProxyMain.getInstance();

    public discord() {
        super("discord");
    }

    @Override
    public void execute(CommandSender commandSender, String[] strings) {
        if (commandSender instanceof ProxiedPlayer) {
            ProxiedPlayer player = (ProxiedPlayer) commandSender;

            try {
                // GET request to link to discord.
                Request req = Request.builder()
                        .setURL(ConfigurationManager.getConfig().get("BaseAPIURL") + "/web/configuration")
                        .setMethod(Request.Method.GET)
                        .addHeader("x-access-token", String.valueOf(ConfigurationManager.getConfig().get("APIKey")))
                        .build();

                Response res = req.execute();
                String json = res.getBody();
                String siteAddress = JsonPath.read(json, "$.data.siteAddress");

                TextComponent message = new TextComponent("Get to know the community and join our Discord here: " + ChatColor.BLUE + siteAddress + "/discord");
                message.setClickEvent(new ClickEvent(ClickEvent.Action.OPEN_URL, siteAddress + "/discord"));
                player.sendMessage(message);
                return;
            } catch (Exception e) {
                player.sendMessage(new TextComponent("An error has occurred. Is the API down?"));
                System.out.println(e);
            }
        }
    }

}
