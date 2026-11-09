package dev.anchorlight.zander.velocity.model.nickname;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

import java.util.UUID;

/** Request body for POST /api/nickname/set. color may be null (plain nickname). */
@Builder
public class NicknameSet {
    @Getter UUID uuid;
    @Getter String name;
    @Getter String color;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }
}
