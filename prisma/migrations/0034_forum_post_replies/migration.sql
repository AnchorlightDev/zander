-- Preserve which post a chronological forum reply is responding to.
ALTER TABLE `forumPosts`
    ADD COLUMN `replyToPostId` INT NULL AFTER `userId`,
    ADD INDEX `forumPosts_reply_to_idx` (`replyToPostId`),
    ADD CONSTRAINT `fk_forumPosts_reply_to`
        FOREIGN KEY (`replyToPostId`) REFERENCES `forumPosts`(`postId`) ON DELETE SET NULL;
