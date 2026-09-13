package dev.anchorlight.zander.velocity.util.messaging;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import org.slf4j.Logger;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class PrivateMessageService {

    private static final String STORAGE_FILE = "private-messages.json";

    private final Path storagePath;
    private final Gson gson;
    private final Logger logger;
    private final Object lock = new Object();
    private final Map<UUID, UUID> lastConversation = new ConcurrentHashMap<>();
    private MessagingData data;

    public PrivateMessageService(Path dataDirectory, Logger logger) {
        this.storagePath = dataDirectory.resolve(STORAGE_FILE);
        this.gson = new GsonBuilder().setPrettyPrinting().create();
        this.logger = logger;
        load();
    }

    public void updateNameCache(UUID uuid, String name) {
        if (uuid == null || name == null) {
            return;
        }
        synchronized (lock) {
            String key = uuid.toString();
            String existing = data.nameCache.get(key);
            if (!name.equals(existing)) {
                data.nameCache.put(key, name);
                save();
            }
        }
    }

    public Optional<UUID> resolveUuid(String name, ProxyServer proxy) {
        if (name == null) {
            return Optional.empty();
        }
        Optional<Player> online = proxy.getPlayer(name);
        if (online.isPresent()) {
            Player player = online.get();
            updateNameCache(player.getUniqueId(), player.getUsername());
            return Optional.of(player.getUniqueId());
        }
        synchronized (lock) {
            for (Map.Entry<String, String> entry : data.nameCache.entrySet()) {
                if (entry.getValue() != null && entry.getValue().equalsIgnoreCase(name)) {
                    try {
                        return Optional.of(UUID.fromString(entry.getKey()));
                    } catch (IllegalArgumentException ignored) {
                        return Optional.empty();
                    }
                }
            }
        }
        return Optional.empty();
    }

    public Optional<String> getCachedName(UUID uuid) {
        if (uuid == null) {
            return Optional.empty();
        }
        synchronized (lock) {
            return Optional.ofNullable(data.nameCache.get(uuid.toString()));
        }
    }

    public boolean isMessagesDisabled(UUID uuid) {
        if (uuid == null) {
            return false;
        }
        synchronized (lock) {
            return Boolean.TRUE.equals(data.messagesDisabled.get(uuid.toString()));
        }
    }

    public void setMessagesDisabled(UUID uuid, boolean disabled) {
        if (uuid == null) {
            return;
        }
        synchronized (lock) {
            String key = uuid.toString();
            if (disabled) {
                data.messagesDisabled.put(key, true);
            } else {
                data.messagesDisabled.remove(key);
            }
            save();
        }
    }

    public boolean isIgnoring(UUID owner, UUID target) {
        if (owner == null || target == null) {
            return false;
        }
        synchronized (lock) {
            Set<String> ignores = data.ignoreList.get(owner.toString());
            return ignores != null && ignores.contains(target.toString());
        }
    }

    public boolean addIgnore(UUID owner, UUID target) {
        if (owner == null || target == null) {
            return false;
        }
        synchronized (lock) {
            Set<String> ignores = data.ignoreList.computeIfAbsent(owner.toString(), key -> new HashSet<>());
            boolean added = ignores.add(target.toString());
            if (added) {
                save();
            }
            return added;
        }
    }

    public boolean removeIgnore(UUID owner, UUID target) {
        if (owner == null || target == null) {
            return false;
        }
        synchronized (lock) {
            Set<String> ignores = data.ignoreList.get(owner.toString());
            if (ignores == null) {
                return false;
            }
            boolean removed = ignores.remove(target.toString());
            if (removed) {
                if (ignores.isEmpty()) {
                    data.ignoreList.remove(owner.toString());
                }
                save();
            }
            return removed;
        }
    }

    public Set<UUID> getIgnoreList(UUID owner) {
        if (owner == null) {
            return Collections.emptySet();
        }
        synchronized (lock) {
            Set<String> ignores = data.ignoreList.get(owner.toString());
            if (ignores == null || ignores.isEmpty()) {
                return Collections.emptySet();
            }
            Set<UUID> results = new HashSet<>();
            for (String entry : ignores) {
                try {
                    results.add(UUID.fromString(entry));
                } catch (IllegalArgumentException ignored) {
                    // ignore invalid entries
                }
            }
            return results;
        }
    }

    public void setLastConversation(UUID sender, UUID target) {
        if (sender == null || target == null) {
            return;
        }
        lastConversation.put(sender, target);
        lastConversation.put(target, sender);
    }

    public Optional<UUID> getLastConversation(UUID sender) {
        if (sender == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(lastConversation.get(sender));
    }

    public void clearLastConversation(UUID sender) {
        if (sender == null) {
            return;
        }
        lastConversation.remove(sender);
    }

    private void load() {
        synchronized (lock) {
            data = new MessagingData();
            if (!Files.exists(storagePath)) {
                return;
            }
            try (Reader reader = Files.newBufferedReader(storagePath)) {
                MessagingData loaded = gson.fromJson(reader, MessagingData.class);
                if (loaded != null) {
                    data = loaded;
                    if (data.messagesDisabled == null) {
                        data.messagesDisabled = new HashMap<>();
                    }
                    if (data.ignoreList == null) {
                        data.ignoreList = new HashMap<>();
                    }
                    if (data.nameCache == null) {
                        data.nameCache = new HashMap<>();
                    }
                }
            } catch (IOException e) {
                logger.error("Failed to load private message storage.", e);
            }
        }
    }

    private void save() {
        synchronized (lock) {
            try {
                Files.createDirectories(storagePath.getParent());
                try (Writer writer = Files.newBufferedWriter(storagePath)) {
                    gson.toJson(data, writer);
                }
            } catch (IOException e) {
                logger.error("Failed to save private message storage.", e);
            }
        }
    }

    private static class MessagingData {
        private Map<String, Boolean> messagesDisabled = new HashMap<>();
        private Map<String, Set<String>> ignoreList = new HashMap<>();
        private Map<String, String> nameCache = new HashMap<>();
    }
}
