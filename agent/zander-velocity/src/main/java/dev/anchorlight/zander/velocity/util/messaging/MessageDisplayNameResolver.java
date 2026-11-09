package dev.anchorlight.zander.velocity.util.messaging;

import com.velocitypowered.api.proxy.Player;
import dev.anchorlight.zander.velocity.util.nickname.NicknameCache;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;

import java.lang.reflect.Method;
import java.util.UUID;

public class MessageDisplayNameResolver {

    private MessageDisplayNameResolver() {
    }

    public static Component resolve(Player player) {
        // Nickname-aware name (with ~ marker and a hover revealing the real
        // username); falls back to the real username when there is no nickname.
        Component name = NicknameCache.displayName(player);
        Component prefix = resolveLuckPermsPrefix(player);
        if (prefix != null) {
            return prefix.append(name);
        }
        return name;
    }

    private static Component resolveVelocityDisplayName(Player player) {
        try {
            Method method = player.getClass().getMethod("getDisplayName");
            Object result = method.invoke(player);
            if (result instanceof Component) {
                return (Component) result;
            }
        } catch (ReflectiveOperationException ignored) {
            return null;
        }
        return null;
    }

    private static Component resolveLuckPermsPrefix(Player player) {
        try {
            Class<?> providerClass = Class.forName("net.luckperms.api.LuckPermsProvider");
            Object luckPerms = providerClass.getMethod("get").invoke(null);
            Object userManager = luckPerms.getClass().getMethod("getUserManager").invoke(luckPerms);
            UUID uuid = player.getUniqueId();
            Object user = userManager.getClass().getMethod("getUser", UUID.class).invoke(userManager, uuid);
            if (user == null) {
                return null;
            }
            Object cachedData = user.getClass().getMethod("getCachedData").invoke(user);
            Object metaData = cachedData.getClass().getMethod("getMetaData").invoke(cachedData);
            String prefix = (String) metaData.getClass().getMethod("getPrefix").invoke(metaData);
            if (prefix == null || prefix.isBlank()) {
                return null;
            }
            return LegacyComponentSerializer.legacyAmpersand().deserialize(prefix);
        } catch (ReflectiveOperationException | LinkageError ignored) {
            return null;
        }
    }
}
