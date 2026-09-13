package dev.anchorlight.zander.pgm.util;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

/** Shared Gson instance and helpers. */
public final class JsonUtil {

    private static final Gson GSON = new GsonBuilder()
            .disableHtmlEscaping()
            .serializeNulls()
            .create();

    private JsonUtil() {
    }

    public static Gson gson() {
        return GSON;
    }

    public static String toJson(Object o) {
        return GSON.toJson(o);
    }

    public static <T> T fromJson(String json, Class<T> type) {
        return GSON.fromJson(json, type);
    }
}
