package dev.anchorlight.zander.velocity.model;

import com.google.gson.Gson;
import lombok.Builder;
import lombok.Getter;

@Builder
public class Report {

    @Getter String reportPlatform;
    @Getter String reportedUser;
    @Getter String reporterUser;
    @Getter String reportReason;

    @Override
    public String toString() {
        return new Gson().toJson(this);
    }

}