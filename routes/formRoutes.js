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
  deleteDraft,
  getDraft,
  getFormBySlug,
  getLastDenial,
  saveDraft,
  setSubmissionDiscordMessage,
  setSubmissionTicket,
} from "../controllers/formController.js";
import { notifyNewSubmission } from "../services/formDiscordService.js";
import { checkRequirements } from "../services/formRequirementsService.js";
import { openTicketForSubmission } from "../services/formTicketService.js";
import {
  hasUnlocked,
  markUnlocked,
  requiresAccessCode,
  verifyAccessCode,
} from "../lib/formAccess.mjs";
import {
  collectDraftAnswers,
  getFieldConfig,
  getMaxImages,
  getScaleRange,
  groupIntoSections,
  isAutoFillType,
  isDisplayType,
  isSinglePage,
  normaliseOptions,
  validateSubmission,
} from "../lib/formFields.js";
import { evaluateCooldown } from "../lib/formCooldown.mjs";

export default function formSiteRoutes(app, config, features) {
  /**
   * Fields the visitor actually fills in. Auto-fill types are resolved
   * server-side from the session, so they are neither rendered as inputs nor
   * read from the body -- see validateSubmission.
   */
  const visibleFields = (form) =>
    form.fields
      .filter((f) => !isAutoFillType(f.fieldType))
      .map((f) => ({
        ...f,
        choices: normaliseOptions(f.options),
        // Resolved here rather than in the template so the view never has to
        // reason about defaults or clamping -- it renders what it is handed.
        maxImages: getMaxImages(f),
        scale: getScaleRange(f),
        showIf: getFieldConfig(f).showIf ?? null,
      }));

  /**
   * The same list, split into the pages the wizard steps through.
   *
   * A form with no section markers yields exactly one untitled page, which the
   * template renders without any wizard chrome -- so every form built before
   * sections existed looks and behaves as it always did.
   */
  const pagesFor = (form) => {
    const fields = visibleFields(form);
    return {
      sections: groupIntoSections(fields),
      singlePage: isSinglePage(fields),
      questionCount: fields.filter((f) => !isDisplayType(f.fieldType)).length,
    };
  };

  // Image answers must point at our own Cloudinary cloud; lib/formFields.js
  // reads no environment of its own, so the check is fed from here.
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || null;

  const gatePage = async (req, res, form, view) =>
    res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("modules/forms/gate", {
        pageTitle: form.name,
        pageDescription: form.description || `Submit the ${form.name} form.`,
        config, features, req,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
        form,
        codeError: null,
        checks: [],
        cooldownMessage: null,
        ...view,
      })
    );

  /**
   * Everything that has to be true before the questions are worth rendering.
   *
   * Run on GET before the fields, and again on POST before anything is stored:
   * a gate that only runs on render is no gate at all, since the form posts to
   * a URL anyone can hit directly.
   *
   * Returns null when the visitor may proceed, or a { mode, ... } describing
   * which gate stopped them.
   *
   * `skipRequirements` is for the autosave endpoint, which fires every couple
   * of seconds while someone types: running the requirement checks there would
   * mean a LiteBans round trip per burst of typing, to re-answer a question
   * that was already answered when the page rendered and will be answered
   * again on submit. The cheap gates still run.
   */
  const gateFor = async (req, form, user, { skipRequirements = false } = {}) => {
    // Passcode first: it costs nothing, where the requirement checks hit
    // LiteBans and the session tables.
    if (requiresAccessCode(form) && !hasUnlocked(req.session, form.slug)) {
      return { mode: "code" };
    }

    // Cooldown before requirements: it is one indexed lookup where the
    // requirement checks hit LiteBans and the session tables, and it is the
    // more specific answer for someone who was recently denied.
    if (form.reapplyCooldownDays) {
      const cooldown = evaluateCooldown({
        lastDenial: await getLastDenial(form.formId, user.userId),
        cooldownDays: form.reapplyCooldownDays,
      });
      if (cooldown.blocked) {
        return { mode: "cooldown", cooldownMessage: cooldown.message };
      }
    }

    if (skipRequirements) return null;

    const requirements = await checkRequirements(form, user.userId);
    if (!requirements.ok) {
      return { mode: "requirements", checks: requirements.checks };
    }

    return null;
  };

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

    const gate = await gateFor(req, form, req.session.user);
    if (gate) return gatePage(req, res, form, gate);

    // A closed form still renders, so an existing link explains itself rather
    // than 404-ing; the submit button is replaced with a notice.
    const alreadySubmitted =
      form.allowMultiple === false &&
      (await countUserSubmissions(form.formId, req.session.user.userId)) > 0;

    // A saved draft pre-fills the fields, with a notice saying so -- silently
    // restoring old answers would be worse than losing them.
    const draft = alreadySubmitted ? null : await getDraft(form.formId, req.session.user.userId);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("modules/forms/form", {
        pageTitle: form.name,
        pageDescription: form.description || `Submit the ${form.name} form.`,
        config, features, req,
        globalImage: await getGlobalImage(),
        announcementWeb: await getWebAnnouncement(),
        form,
        ...pagesFor(form),
        alreadySubmitted,
        errors: [],
        errorKeys: [],
        values: draft?.answers ?? {},
        draftSavedAt: draft?.updatedAt ?? null,
      })
    );
  });

  /**
   * Accept (or reject) a form's access code.
   *
   * Separate from the submit route so the two bodies cannot be confused for
   * one another. A correct code is remembered against the session for this
   * slug, so a validation error part-way through a long form does not send the
   * applicant back here with their answers gone.
   */
  app.post("/forms/:slug/access", async (req, res) => {
    if (!(await isFeatureWebRouteEnabled(app, features.forms, req, res, features))) return;

    const form = await getFormBySlug(req.params.slug);
    if (!form) {
      setBannerCookie("danger", "That form no longer exists.", res);
      return res.redirect("/");
    }

    if (!isLoggedIn(req)) {
      return res.redirect(`/login?returnTo=/forms/${encodeURIComponent(form.slug)}`);
    }

    if (!requiresAccessCode(form)) {
      return res.redirect(`/forms/${form.slug}`);
    }

    if (!verifyAccessCode(form.accessCode, req.body?.accessCode)) {
      // Plainly rejected, immediately retryable -- no counter, no lockout.
      return gatePage(req, res, form, {
        mode: "code",
        codeError: "That code is not right. Check it and try again.",
      });
    }

    markUnlocked(req.session, form.slug);
    return res.redirect(`/forms/${form.slug}`);
  });

  /**
   * Autosave, called from the page as answers change.
   *
   * Answers JSON, not a redirect: this is a background save, and the applicant
   * must not be navigated anywhere. Enforces nothing about the content -- a
   * draft is half-finished by definition -- beyond keeping it to this form's
   * own fields.
   */
  app.post("/forms/:slug/draft", async (req, res) => {
    if (!(await isFeatureWebRouteEnabled(app, features.forms, req, res, features))) return;

    const form = await getFormBySlug(req.params.slug);
    if (!form) return res.status(404).send({ success: false, message: "Form not found." });

    if (!isLoggedIn(req)) {
      return res.status(401).send({ success: false, message: "Authentication required." });
    }

    // The cheap gates apply here too: someone who cannot see the questions has
    // no business filing answers to them. The requirement checks are left to
    // render and submit -- a stored draft is not a submission, and re-running
    // them on every autosave would be a lot of querying for no extra safety.
    if (await gateFor(req, form, req.session.user, { skipRequirements: true })) {
      return res.status(403).send({ success: false, message: "This form is not available to you." });
    }

    try {
      const answers = collectDraftAnswers(form.fields, req.body || {}, { cloudName });
      const draft = await saveDraft(form.formId, req.session.user.userId, answers);
      return res.send({ success: true, data: { savedAt: draft.updatedAt } });
    } catch (error) {
      console.error("[forms] Draft save failed:", error.message);
      return res.status(500).send({ success: false, message: "Could not save your draft." });
    }
  });

  /** Throw away the saved draft and start again. */
  app.post("/forms/:slug/draft/discard", async (req, res) => {
    if (!(await isFeatureWebRouteEnabled(app, features.forms, req, res, features))) return;

    const form = await getFormBySlug(req.params.slug);
    if (!form) {
      setBannerCookie("danger", "That form no longer exists.", res);
      return res.redirect("/");
    }

    if (!isLoggedIn(req)) {
      return res.redirect(`/login?returnTo=/forms/${encodeURIComponent(form.slug)}`);
    }

    await deleteDraft(form.formId, req.session.user.userId);
    setBannerCookie("success", "Your saved draft has been discarded.", res);
    return res.redirect(`/forms/${form.slug}`);
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

    // Re-checked here, not just on render: posting straight to this URL skips
    // the page that enforced them.
    const gate = await gateFor(req, form, user);
    if (gate) return gatePage(req, res, form, gate);

    const body = req.body || {};
    const { ok, errors, errorKeys, answers } = validateSubmission(form.fields, body, {
      user,
      cloudName,
    });

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
          ...pagesFor(form),
          alreadySubmitted: false,
          errors,
          // Names the fields that failed, so the wizard reopens on the page
          // holding the first of them rather than back at step one.
          errorKeys,
          values: body,
          draftSavedAt: null,
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

    // The answers are a submission now, so the draft is only noise. Best-effort
    // like everything else after the commit.
    try {
      await deleteDraft(form.formId, user.userId);
    } catch (error) {
      console.error("[forms] Draft cleanup failed:", error.message);
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

    // Also best-effort: a form with the option on gets a support ticket so the
    // submitter has somewhere to be kept informed. A failure here leaves
    // ticketId null and the submission otherwise intact.
    let ticketId = null;
    try {
      ticketId = await openTicketForSubmission({
        form,
        fields: form.fields,
        answers,
        submissionId: submission.submissionId,
        user,
      });
      if (ticketId) {
        await setSubmissionTicket(submission.submissionId, ticketId);
      }
    } catch (error) {
      console.error("[forms] Ticket creation failed:", error.message);
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
        ticketId,
      })
    );
  });
}
