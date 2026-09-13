package dev.anchorlight.zander.addon.model;

import lombok.Data;
import java.util.Map;

@Data
public class SocialConfig {
    private Map<String, String> platforms;
}
