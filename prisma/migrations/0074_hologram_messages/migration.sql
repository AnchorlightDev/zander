-- Dashboard-managed text for the in-game rotating holograms rendered by the
-- zander-hub plugin. Each row is one "frame" in a hologram's rotation; the hub
-- polls these, groups them by `hologram_group`, and cycles each placed hologram
-- through its group's enabled frames. `link` (optional) is offered to a player
-- who right-clicks the hologram while that frame is showing.
CREATE TABLE `hologram_messages` (
  `id`             INT          NOT NULL AUTO_INCREMENT,
  `hologram_group` VARCHAR(64)  NOT NULL DEFAULT 'default',
  `message`        TEXT         NOT NULL,
  `link`           VARCHAR(512) NULL,
  `sort_order`     INT          NOT NULL DEFAULT 0,
  `enabled`        TINYINT      NOT NULL DEFAULT 1,
  `created_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `hologram_messages_group_idx` (`hologram_group`, `enabled`, `sort_order`)
);
