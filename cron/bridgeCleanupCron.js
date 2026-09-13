import cron from "node-cron";
import db from "../controllers/databaseController.js";

// Reset stale processing tasks every 15 minutes.
// Tasks stuck in 'processing' for more than 10 minutes are assumed to have been
// lost (addon crashed or never reported back) and are returned to 'pending' so
// they will be re-claimed on the next poll cycle.
var bridgeResetTask = cron.schedule("*/15 * * * *", () => {
  db.query(
    `UPDATE executorTasks
     SET status = 'pending', executedBy = NULL, result = NULL, processedAt = NULL, updatedAt = NOW()
     WHERE status = 'processing' AND updatedAt <= NOW() - INTERVAL 10 MINUTE`,
    function (error, results) {
      if (error) return console.log(`Bridge reset error: ${error}`);
      if (results.affectedRows > 0)
        console.log(`Bridge: reset ${results.affectedRows} stale processing task(s) back to pending.`);
    }
  );
});

// Daily cleanup at 00:05 — purge old completed/failed records.
var bridgeCleanupTask = cron.schedule("5 0 * * *", () => {
  try {
    db.query(
      `DELETE FROM executorTasks WHERE status IN ('completed', 'failed') AND updatedAt <= NOW() - INTERVAL 7 DAY`,
      function (error, results) {
        if (error) return console.log(`Bridge cleanup error: ${error}`);
        console.log(`Bridge cleanup removed ${results.affectedRows} completed tasks.`);
      }
    );
  } catch (error) {
    console.log(`Error: ${error}`);
  }
});

bridgeResetTask.start();
bridgeCleanupTask.start();
