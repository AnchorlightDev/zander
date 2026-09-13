package dev.anchorlight.zander.addon.service;

import org.bukkit.plugin.java.JavaPlugin;

/** Resolves the configured zander-web base URL. */
final class ApiUrl {
    private ApiUrl() {
    }

    /// The site root from `api-url`, without a trailing slash or `/api`, so request paths can always
    /// start with `/api/`. Older configs set `api-url` to `https://.../api`; both forms work.
    static String base(JavaPlugin plugin) {
        String url = plugin.getConfig().getString("api-url", "").trim();
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        if (url.endsWith("/api")) {
            url = url.substring(0, url.length() - 4);
        }
        return url;
    }
}
