/**
 * routes/dashboard/forms.js
 *
 * Admin UI for the form builder: build forms and their fields, and review the
 * submissions they collect.
 *
 * Follows the newer dashboard convention (see rankCatalog.js) of posting
 * straight back to /dashboard/... and calling the controller in-process,
 * rather than the older /redirect/... -> /api/... self-call round trip.
 */

import { hasPermission, isFeatureWebRouteEnabled, setBannerCookie } from "../../api/common.js";
import { getWebAnnouncement } from "../../controllers/announcementController.js";
import { getSupportCategories } from "../../controllers/supportTicketController.js";
import { prisma } from "../../controllers/databaseController.js";
import {
  countPendingByForm,
  createForm,
  deleteForm,
  deleteSubmission,
  getFormById,
  getSubmission,
  listForms,
  listSubmissions,
  replaceFields,
  reviewSubmission,
  updateForm,
} from "../../controllers/formController.js";
import { notifySubmissionReviewed } from "../../services/formDiscordService.js";
import { postReviewToTicket } from "../../services/formTicketService.js";
import {
  FIELD_TYPES,
  formatAnswer,
  isValidSubmissionStatus,
  optionsToText,
} from "../../lib/formFields.js";

const PERMISSION = "zander.web.forms";

/**
 * The field editor posts its rows as a single JSON string, because the row
 * count is dynamic and PHP-style `fields[0][label]` names are painful to parse
 * consistently across Fastify's body parsers.
 */
function parseFieldsPayload(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Attach usernames to submissions without an N+1 lookup per row. */
async function withSubmitterNames(submissions) {
  const userIds = [...new Set(submissions.flatMap((s) => [s.userId, s.reviewedBy]).filter(Boolean))];
  if (!userIds.length) return submissions.map((s) => ({ ...s, submitterName: null, reviewerName: null }));

  const users = await prisma.users.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, username: true },
  });
  const names = new Map(users.map((u) => [u.userId, u.username]));

  return submissions.map((s) => ({
    ...s,
    submitterName: names.get(s.userId) ?? `User #${s.userId}`,
    reviewerName: s.reviewedBy ? names.get(s.reviewedBy) ?? `User #${s.reviewedBy}` : null,
  }));
}

export default function dashboardFormsRoute(app, config, db, features, lang) {
  const guard = async (req, res) => {
    if (!(await isFeatureWebRouteEnabled(app, features.forms, req, res, features))) return false;
    if (!(await hasPermission(PERMISSION, req, res, features))) return false;
    return true;
  };

  // ── Forms list ────────────────────────────────────────────────────────────
  app.get("/dashboard/forms", async (req, res) => {
    if (!(await guard(req, res))) return;

    const [forms, pendingCounts, announcementWeb] = await Promise.all([
      listForms(),
      countPendingByForm(),
      getWebAnnouncement(),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forms/form-list", {
        pageTitle: "Dashboard - Forms",
        config, features, req, announcementWeb,
        forms: forms.map((f) => ({ ...f, pendingCount: pendingCounts.get(f.formId) || 0 })),
      })
    );
  });

  // ── Create ────────────────────────────────────────────────────────────────
  app.get("/dashboard/forms/create", async (req, res) => {
    if (!(await guard(req, res))) return;

    const [announcementWeb, supportCategories] = await Promise.all([
      getWebAnnouncement(),
      getSupportCategories().catch(() => []),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forms/form-editor", {
        pageTitle: "Dashboard - Create Form",
        config, features, req, announcementWeb,
        form: null,
        fields: [],
        fieldTypes: FIELD_TYPES,
        supportCategories,
        formAction: "/dashboard/forms/create",
      })
    );
  });

  app.post("/dashboard/forms/create", async (req, res) => {
    if (!(await guard(req, res))) return;

    const body = req.body || {};
    if (!String(body.name || "").trim()) {
      setBannerCookie("danger", "A form name is required.", res);
      return res.redirect("/dashboard/forms/create");
    }

    try {
      const form = await createForm({
        name: String(body.name).trim(),
        slug: body.slug,
        description: body.description,
        status: body.status === "1" || body.status === "on",
        successMessage: body.successMessage,
        discordChannelId: body.discordChannelId,
        allowMultiple: body.allowMultiple === "1" || body.allowMultiple === "on",
        createTicket: body.createTicket === "1" || body.createTicket === "on",
        ticketCategoryId: body.ticketCategoryId,
      });
      await replaceFields(form.formId, parseFieldsPayload(body.fields));

      setBannerCookie("success", `Form "${form.name}" has been created.`, res);
      return res.redirect(`/dashboard/forms/${form.formId}/edit`);
    } catch (error) {
      console.error("[forms] create error:", error);
      setBannerCookie("danger", "The form could not be created.", res);
      return res.redirect("/dashboard/forms/create");
    }
  });

  // ── Edit ──────────────────────────────────────────────────────────────────
  app.get("/dashboard/forms/:formId/edit", async (req, res) => {
    if (!(await guard(req, res))) return;

    const form = await getFormById(req.params.formId);
    if (!form) {
      setBannerCookie("danger", "Form not found.", res);
      return res.redirect("/dashboard/forms");
    }

    const [announcementWeb, supportCategories] = await Promise.all([
      getWebAnnouncement(),
      getSupportCategories().catch(() => []),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forms/form-editor", {
        pageTitle: `Dashboard - Edit ${form.name}`,
        config, features, req, announcementWeb,
        supportCategories,
        form,
        // The editor works in the newline-per-option text form, not JSON.
        fields: form.fields.map((f) => ({ ...f, optionsText: optionsToText(f.options) })),
        fieldTypes: FIELD_TYPES,
        formAction: `/dashboard/forms/${form.formId}/edit`,
      })
    );
  });

  app.post("/dashboard/forms/:formId/edit", async (req, res) => {
    if (!(await guard(req, res))) return;

    const formId = req.params.formId;
    const body = req.body || {};
    if (!String(body.name || "").trim()) {
      setBannerCookie("danger", "A form name is required.", res);
      return res.redirect(`/dashboard/forms/${formId}/edit`);
    }

    try {
      await updateForm(formId, {
        name: String(body.name).trim(),
        slug: body.slug,
        description: body.description,
        status: body.status === "1" || body.status === "on",
        successMessage: body.successMessage,
        discordChannelId: body.discordChannelId,
        allowMultiple: body.allowMultiple === "1" || body.allowMultiple === "on",
        createTicket: body.createTicket === "1" || body.createTicket === "on",
        ticketCategoryId: body.ticketCategoryId,
      });
      await replaceFields(formId, parseFieldsPayload(body.fields));

      setBannerCookie("success", "The form has been updated.", res);
    } catch (error) {
      console.error("[forms] edit error:", error);
      setBannerCookie("danger", "The form could not be updated.", res);
    }
    return res.redirect(`/dashboard/forms/${formId}/edit`);
  });

  app.post("/dashboard/forms/:formId/delete", async (req, res) => {
    if (!(await guard(req, res))) return;

    try {
      await deleteForm(req.params.formId);
      setBannerCookie("success", "The form and its submissions have been deleted.", res);
    } catch (error) {
      console.error("[forms] delete error:", error);
      setBannerCookie("danger", "The form could not be deleted.", res);
    }
    return res.redirect("/dashboard/forms");
  });

  // ── Submissions ───────────────────────────────────────────────────────────
  app.get("/dashboard/forms/submissions", async (req, res) => {
    if (!(await guard(req, res))) return;

    const { formId = null, status = null } = req.query || {};

    const [rows, forms, announcementWeb] = await Promise.all([
      listSubmissions({
        formId: formId || null,
        status: isValidSubmissionStatus(status) ? status : null,
      }),
      listForms(),
      getWebAnnouncement(),
    ]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forms/submission-list", {
        pageTitle: "Dashboard - Form Submissions",
        config, features, req, announcementWeb,
        submissions: await withSubmitterNames(rows),
        forms,
        activeFormId: formId ? String(formId) : "",
        activeStatus: isValidSubmissionStatus(status) ? String(status) : "",
      })
    );
  });

  app.get("/dashboard/forms/submissions/view", async (req, res) => {
    if (!(await guard(req, res))) return;

    const submission = await getSubmission(req.query?.submissionId);
    if (!submission) {
      setBannerCookie("danger", "Submission not found.", res);
      return res.redirect("/dashboard/forms/submissions");
    }

    const [decorated] = await withSubmitterNames([submission]);

    return res.header("content-type", "text/html; charset=utf-8").send(
      await app.view("dashboard/forms/submission-view", {
        pageTitle: `Dashboard - Submission #${submission.submissionId}`,
        config, features, req,
        announcementWeb: await getWebAnnouncement(),
        submission: decorated,
        // Pre-rendered so the template stays presentational -- the same
        // formatter the Discord embed uses, so both read identically.
        answerRows: submission.form.fields.map((field) => ({
          label: field.label,
          fieldType: field.fieldType,
          value: formatAnswer(field, submission.answers?.[field.fieldKey]),
        })),
      })
    );
  });

  app.post("/dashboard/forms/submissions/review", async (req, res) => {
    if (!(await guard(req, res))) return;

    const body = req.body || {};
    const submissionId = body.submissionId;
    const status = String(body.status || "");

    if (!isValidSubmissionStatus(status)) {
      setBannerCookie("danger", "That is not a valid submission status.", res);
      return res.redirect("/dashboard/forms/submissions");
    }

    try {
      await reviewSubmission({
        submissionId,
        status,
        reviewNotes: body.reviewNotes,
        reviewedBy: req.session?.user?.userId ?? null,
      });

      // Best-effort: the review is already saved, so a Discord failure here
      // must not surface as a failed review.
      const submission = await getSubmission(submissionId);
      if (submission?.form?.discordChannelId) {
        await notifySubmissionReviewed({
          form: submission.form,
          submissionId: submission.submissionId,
          status,
          reviewer: req.session?.user?.username ?? null,
        });
      }

      // Tell the submitter directly, in the ticket opened for them. Internal
      // review notes are deliberately not forwarded -- only the decision.
      if (submission?.ticketId) {
        await postReviewToTicket({
          submission,
          status,
          reviewer: req.session?.user?.username ?? null,
        });
      }

      setBannerCookie("success", `Submission #${submissionId} marked as ${status}.`, res);
    } catch (error) {
      console.error("[forms] review error:", error);
      setBannerCookie("danger", "The submission could not be updated.", res);
    }
    return res.redirect(`/dashboard/forms/submissions/view?submissionId=${submissionId}`);
  });

  app.post("/dashboard/forms/submissions/delete", async (req, res) => {
    if (!(await guard(req, res))) return;

    try {
      await deleteSubmission(req.body?.submissionId);
      setBannerCookie("success", "The submission has been deleted.", res);
    } catch (error) {
      console.error("[forms] submission delete error:", error);
      setBannerCookie("danger", "The submission could not be deleted.", res);
    }
    return res.redirect("/dashboard/forms/submissions");
  });
}
