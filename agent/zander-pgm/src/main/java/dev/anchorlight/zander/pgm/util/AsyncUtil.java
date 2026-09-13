package dev.anchorlight.zander.pgm.util;

import org.bukkit.Bukkit;
import org.bukkit.plugin.Plugin;

import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;

/**
 * Helpers for hopping between the async world (network I/O) and the Bukkit main
 * thread (world/PGM reads). Network calls must never run on the main thread.
 */
public final class AsyncUtil {

    private AsyncUtil() {
    }

    /** Run a task on the Bukkit main thread. */
    public static void sync(Plugin plugin, Runnable runnable) {
        if (Bukkit.isPrimaryThread()) {
            runnable.run();
        } else {
            Bukkit.getScheduler().runTask(plugin, runnable);
        }
    }

    /** Run a task asynchronously off the main thread. */
    public static void async(Plugin plugin, Runnable runnable) {
        Bukkit.getScheduler().runTaskAsynchronously(plugin, runnable);
    }

    /**
     * Compute a value on the main thread and complete a future with it. Useful
     * when async code needs a snapshot of Bukkit/PGM state.
     */
    public static <T> CompletableFuture<T> supplySync(Plugin plugin, Supplier<T> supplier) {
        CompletableFuture<T> future = new CompletableFuture<>();
        sync(plugin, () -> {
            try {
                future.complete(supplier.get());
            } catch (Throwable t) {
                future.completeExceptionally(t);
            }
        });
        return future;
    }
}
