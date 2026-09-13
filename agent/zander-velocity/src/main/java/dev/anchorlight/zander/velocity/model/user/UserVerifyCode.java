package dev.anchorlight.zander.velocity.model.user;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

import java.util.UUID;

@Builder
public class UserVerifyCode {
    @Getter UUID uuid;
    @Getter String code;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }
}
