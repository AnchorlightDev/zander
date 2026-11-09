package dev.anchorlight.zander.velocity.model.nickname;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

import java.util.UUID;

/** Request body for POST /api/nickname/clear. */
@Builder
public class NicknameClear {
    @Getter UUID uuid;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }
}
