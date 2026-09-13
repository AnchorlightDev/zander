/**
 * Event Template Draft Generation Cron
 * Runs every hour. Checks for active templates whose nextGenerateAt has passed
 * and generates draft events for review.
 */

import cron from "node-cron";
import {
  getTemplatesDueForGeneration,
  generateDraftFromTemplate,
  computeNextEventDate,
  markTemplateGenerated,
  cleanupStaleTemplateEvents,
} from "../services/eventTemplateService.js";

const eventTemplateCronTask = cron.schedule("0 * * * *", async () => {
  // Draft generation
  try {
    const templates = await getTemplatesDueForGeneration();

    if (templates.length > 0) {
      console.log(`[EventTemplateCron] Found ${templates.length} templates due for draft generation`);

      for (const template of templates) {
        try {
          const nextEventDate = computeNextEventDate(template);

          if (!nextEventDate) {
            console.warn(`[EventTemplateCron] Could not compute next event date for template #${template.templateId}`);
            continue;
          }

          const event = await generateDraftFromTemplate(template, nextEventDate, null, "System (Template)");

          await markTemplateGenerated(template.templateId);

          console.log(
            `[EventTemplateCron] Generated draft event #${event.eventId} "${event.title}" from template #${template.templateId}`
          );
        } catch (err) {
          console.error(`[EventTemplateCron] Failed to generate draft for template #${template.templateId}:`, err.message);
        }
      }
    }
  } catch (error) {
    console.error("[EventTemplateCron] Draft generation error:", error);
  }

  // Remove template-generated events that were never promoted and have passed their start time
  try {
    const deleted = await cleanupStaleTemplateEvents();
    if (deleted > 0) {
      console.log(`[EventTemplateCron] Cleaned up ${deleted} stale template-generated event(s)`);
    }
  } catch (err) {
    console.error("[EventTemplateCron] Cleanup error:", err.message);
  }
});

eventTemplateCronTask.start();
