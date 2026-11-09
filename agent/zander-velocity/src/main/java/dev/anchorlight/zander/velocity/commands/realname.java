package dev.anchorlight.zander.velocity.commands;

import com.jayway.jsonpath.DocumentContext;
import com.jayway.jsonpath.JsonPath;
import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import dev.dejvokep.boostedyaml.route.Route;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.zander.velocity.ZanderVelocityMain;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.minimessage.MiniMessage;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * /realname &lt;nickname&gt; — reveal the real username behind a displayed nickname.
 */
public class realname implements SimpleCommand {

    private static final MiniMessage MM = MiniMessage.miniMessage();

    @Override
    public void execute(final Invocation invocation) {
        CommandSource source = invocation.source();
        String[] args = invocation.arguments();

        if (args.length == 0) {
            source.sendMessage(MM.deserialize("<gray>Usage: <white>/realname <nickname></white></gray>"));
            return;
        }

        String base = ZanderVelocityMain.getConfig().getString(Route.from("BaseAPIURL"));
        String apiKey = ZanderVelocityMain.getConfig().getString(Route.from("APIKey"));
        String query = args[0].startsWith("~") ? args[0].substring(1) : args[0];

        ZanderVelocityMain.getProxy().getScheduler()
                .buildTask(ZanderVelocityMain.getInstance(), () -> {
                    try {
                        String encoded = URLEncoder.encode(query, StandardCharsets.UTF_8);
                        Request req = Request.builder()
                                .setURL(base + "/nickname/realname?nickname=" + encoded)
                                .setMethod(Request.Method.GET)
                                .addHeader("x-access-token", apiKey)
                                .build();

                        String json = req.execute().getBody();
                        DocumentContext doc = JsonPath.parse(json);
                        boolean success = Boolean.TRUE.equals(readBool(doc, "$.success"));
                        String username = readString(doc, "$.data.username");

                        if (success && username != null) {
                            source.sendMessage(MM.deserialize(
                                    "<gray>~" + escape(query) + " is <white>" + escape(username) + "</white>.</gray>"));
                        } else {
                            source.sendMessage(Component.text("No player is using that nickname.")
                                    .color(NamedTextColor.RED));
                        }
                    } catch (Exception e) {
                        source.sendMessage(Component.text("Could not reach the nickname service.")
                                .color(NamedTextColor.RED));
                        ZanderVelocityMain.getLogger().error("Realname lookup failed for {}", query, e);
                    }
                }).schedule();
    }

    private static String escape(String input) {
        return input == null ? "" : input.replace("<", "\\<").replace(">", "\\>");
    }

    private static Boolean readBool(DocumentContext doc, String path) {
        try {
            return doc.read(path, Boolean.class);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String readString(DocumentContext doc, String path) {
        try {
            Object v = doc.read(path);
            return v == null ? null : String.valueOf(v);
        } catch (Exception ignored) {
            return null;
        }
    }
}
