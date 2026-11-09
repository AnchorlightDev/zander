package dev.anchorlight.zander.addon.service;

import com.jayway.jsonpath.DocumentContext;
import com.jayway.jsonpath.JsonPath;
import dev.anchorlight.stonelib.http.Request;
import dev.anchorlight.stonelib.http.Response;
import dev.anchorlight.zander.addon.ZanderAddonMain;
import dev.anchorlight.zander.addon.model.NicknameInfo;

import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * Reads a player's effective nickname from the Zander API so the backend can
 * render above-head nametags. The server never touches the database.
 *
 * Uses the shared api-key (x-access-token); that key needs the `nickname` scope.
 */
public class NicknameService {
    private final ZanderAddonMain plugin;

    public NicknameService(ZanderAddonMain plugin) {
        this.plugin = plugin;
    }

    private String token() {
        return plugin.getConfig().getString("api-key", "");
    }

    public CompletableFuture<NicknameInfo> fetch(UUID uuid, String fallbackName) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                Request req = Request.builder()
                        .setURL(ApiUrl.base(plugin) + "/api/nickname/effective?uuid=" + uuid)
                        .setMethod(Request.Method.GET)
                        .addHeader("x-access-token", token())
                        .build();

                Response res = req.execute();
                if (res.getStatusCode() != 200) {
                    return NicknameInfo.plain(fallbackName);
                }

                DocumentContext doc = JsonPath.parse(res.getBody());
                if (!Boolean.TRUE.equals(readBool(doc, "$.success"))) {
                    return NicknameInfo.plain(fallbackName);
                }
                boolean isNick = Boolean.TRUE.equals(readBool(doc, "$.data.isNick"));
                String realname = readString(doc, "$.data.realname", fallbackName);
                String nickname = readString(doc, "$.data.nickname", null);
                String color = readString(doc, "$.data.color", null);
                return new NicknameInfo(realname, nickname, color, isNick);
            } catch (Exception e) {
                plugin.getLogger().warning("Nickname lookup failed for " + uuid + ": " + e.getMessage());
                return NicknameInfo.plain(fallbackName);
            }
        });
    }

    private static Boolean readBool(DocumentContext doc, String path) {
        try {
            return doc.read(path, Boolean.class);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String readString(DocumentContext doc, String path, String fallback) {
        try {
            Object v = doc.read(path);
            return v == null ? fallback : String.valueOf(v);
        } catch (Exception ignored) {
            return fallback;
        }
    }
}
