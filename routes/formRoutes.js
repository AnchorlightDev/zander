/**
 * routes/formRoutes.js
 *
 * Public-facing form pages: render a published form at /forms/<slug> and
 * accept its submissions.
 *
 * Submitting requires a website session. Beyond the obvious spam reason, the
 * auto-filled field types (Minecraft username/UUID, Discord tag, rank) read
 * from the session, and submissions are keyed to a userId so reviewers know
 * who sent what and `allowMultiple` can be enforced.
 */

import {
  getGlobalImage,
  isFeatureWebRouteEnabled,
  isLoggedIn,
  setBannerCookie,
} from "../api/common.js";
import { getWebAnnouncement } from "../controllers/announcementController.js";
import {
  countUserSubmissions,
  createSubmission,
  getFormBySlug,
  setSubmissionDiscordMessage,
} from "../controllers/formController.js";
import { notifyNewSubmission } from "../services/formDiscordService.js";
import { isAutoFillType, normaliseOptions, validateSubmission } from "../lib/formFields.js";

export default function formSiteRoutes(app, config, features) {
  /**
   * Fields the visitor actually fills in. Auto-fill types are resolved
   * server-side from the session, so they are neither rendered as inputs nor
   * read from the body -- see validateSubmission.
   */
  const visibleFields = (form) =>
    form.fields
      .filter((f) => !isAutoFillType(f.fieldType))
      .map((f) => ({ ...f, choices: normaliseOptions(f.options) }));

  app.get("/forms/:slug", async (req, res) => {
    if (!(await isFeatureWebRouteEnabled(app, features.forms, req, res, features))) return;

    const form = await getFormBySlug(req.params.slug);
    if (!form) {
      return res.status(404).header("content-type", "text/html; charset=utf-8").send(
        await app.view("session/notFound", {
          pageTitle: "404 Not Found",
          config, features, req,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
        })
      );
    }

    if (!isLoggedIn(req)) {
      return res.redirect(`/login?returnTo=/forms/${encodeURIComponent(form.slug)}`);
    }

    // A closed form still renders, so an existing link explains itself rather
    // than 404-ing; the submit button is replaced with a notice.
    const alreadySubmitted =
      form.allowMultiple === false &&
      (await countUserSubmissions(form.formId, req.session.user.userId)) > 0;

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("modules/forms/form", {
        pageTitle: form.name,
        pageDescription: form.description || `Submit the ${form.name} form.`,
        config, features, req,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
        form,
        fields: visibleFields(form),
        alreadySubmitted,
        errors: [],
        values: {},
      })
    );
  });

  app.post("/forms/:slug", async (req, res) => {
    if (!(await isFeatureWebRouteEnabled(app, features.forms, req, res, features))) return;

    const form = await getFormBySlug(req.params.slug);
    if (!form) {
      setBannerCookie("danger", "That form no longer exists.", res);
      return res.redirect("/");
    }

    if (!isLoggedIn(req)) {
      return res.redirect(`/login?returnTo=/forms/${encodeURIComponent(form.slug)}`);
    }

    const user = req.session.user;

    if (!form.status) {
      setBannerCookie("danger", "This form is not accepting submissions.", res);
      return res.redirect(`/forms/${form.slug}`);
    }

    if (!form.allowMultiple && (await countUserSubmissions(form.formId, user.userId)) > 0) {
      setBannerCookie("danger", "You have already submitted this form.", res);
      return res.redirect(`/forms/${form.slug}`);
    }

    const body = req.body || {};
    const { ok, errors, answers } = validateSubmission(form.fields, body, { user });

    // Re-render in place rather than redirecting, so a long paragraph answer
    // is not lost to a validation slip on another field.
    if (!ok) {
      return res.header("content-type", "text/html; charset=utf-8").send(
        await app.view("modules/forms/form", {
          pageTitle: form.name,
          pageDescription: form.description || `Submit the ${form.name} form.`,
          config, features, req,
          globalImage: await getGlobalImage(),
          announcementWeb: await getWebAnnouncement(),
          form,
          fields: visibleFields(form),
          alreadySubmitted: false,
          errors,
          values: body,
        })
      );
    }

    let submission;
    try {
      submission = await createSubmission({
        formId: form.formId,
        userId: user.userId,
        answers,
      });
    } catch (error) {
      console.error("[forms] submission failed:", error);
      setBannerCookie("danger", "Your submission could not be saved. Please try again.", res);
      return res.redirect(`/forms/${form.slug}`);
    }

    // Best-effort notification: the submission is committed, so a Discord
    // outage must not read to the submitter as a failure.
    try {
      const messageId = await notifyNewSubmission({
        form,
        fields: form.fields,
        answers,
        submissionId: submission.submissionId,
        submitter: user.username,
        siteAddress: process.env.siteAddress,
      });
      if (messageId) {
        await setSubmissionDiscordMessage(submission.submissionId, messageId);
      }
    } catch (error) {
      console.error("[forms] Discord notification failed:", error.message);
    }

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("modules/forms/submitted", {
        pageTitle: `${form.name} - Submitted`,
        pageDescription: `Your ${form.name} submission has been received.`,
        config, features, req,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
        form,
        submissionId: submission.submissionId,
      })
    );
  });
}
