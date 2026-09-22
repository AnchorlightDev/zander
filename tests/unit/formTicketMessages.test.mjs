/**
 * tests/unit/formTicketMessages.test.mjs
 *
 * The wording posted into a submission's ticket, and the rule that keeps
 * pre-existing internal notes from being published retroactively.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TICKET_MESSAGES,
  buildTicketMessage,
} from "../../lib/formTicketMessages.mjs";

const plainForm = { name: "Staff Application" };

const wordedForm = {
  name: "Builder Application",
  ticketPendingMessage: "Your build application is in the queue.",
  ticketApprovedMessage: "Welcome to the build team!",
  ticketDeniedMessage: "Your build portfolio was not quite what we need yet.",
};

describe("defaults", () => {
  it("falls back when the form has no wording of its own", () => {
    expect(buildTicketMessage("pending", { form: plainForm })).toBe(
      DEFAULT_TICKET_MESSAGES.pending
    );
    expect(buildTicketMessage("approved", { form: plainForm })).toBe(
      DEFAULT_TICKET_MESSAGES.approved
    );
    expect(buildTicketMessage("denied", { form: plainForm })).toBe(
      DEFAULT_TICKET_MESSAGES.denied
    );
  });

  it("falls back when the form has only whitespace in the column", () => {
    const blank = { name: "X", ticketApprovedMessage: "   \n  " };
    expect(buildTicketMessage("approved", { form: blank })).toBe(
      DEFAULT_TICKET_MESSAGES.approved
    );
  });

  it("falls back when there is no form at all", () => {
    expect(buildTicketMessage("denied", {})).toBe(DEFAULT_TICKET_MESSAGES.denied);
    expect(buildTicketMessage("denied")).toBe(DEFAULT_TICKET_MESSAGES.denied);
  });

  it("returns null for a status with nothing to say", () => {
    expect(buildTicketMessage("something-else", { form: plainForm })).toBeNull();
    expect(buildTicketMessage(null, { form: plainForm })).toBeNull();
  });
});

describe("per-form overrides", () => {
  it("uses the form's own wording at each stage", () => {
    expect(buildTicketMessage("pending", { form: wordedForm })).toBe(
      "Your build application is in the queue."
    );
    expect(buildTicketMessage("approved", { form: wordedForm })).toBe(
      "Welcome to the build team!"
    );
    expect(buildTicketMessage("denied", { form: wordedForm })).toBe(
      "Your build portfolio was not quite what we need yet."
    );
  });

  it("lets a Builder denial read differently from a staff one", () => {
    expect(buildTicketMessage("denied", { form: wordedForm })).not.toBe(
      buildTicketMessage("denied", { form: plainForm })
    );
  });

  it("substitutes the placeholders it knows", () => {
    const form = {
      name: "Staff Application",
      ticketApprovedMessage: "Your {form} (#{submissionId}) was approved by {reviewer}.",
    };

    expect(
      buildTicketMessage("approved", { form, submissionId: 42, reviewer: "Ben" })
    ).toContain("Your Staff Application (#42) was approved by Ben.");
  });

  it("leaves an unknown placeholder as literal text", () => {
    const form = { name: "X", ticketApprovedMessage: "Hello {nickname}, you're in." };
    expect(buildTicketMessage("approved", { form })).toBe("Hello {nickname}, you're in.");
  });

  it("leaves a known placeholder alone when there is nothing to put in it", () => {
    const form = { name: "X", ticketApprovedMessage: "Reviewed by {reviewer}." };
    expect(buildTicketMessage("approved", { form })).toBe("Reviewed by {reviewer}.");
  });
});

describe("the reviewer's comment", () => {
  const withComment = (over) => ({
    form: plainForm,
    comment: "Please reapply once you have more building experience.",
    ...over,
  });

  it("is appended under the wording when it is public", () => {
    const body = buildTicketMessage("denied", withComment({ commentIsPublic: true }));

    expect(body).toBe(
      `${DEFAULT_TICKET_MESSAGES.denied}\n\n` +
        "**Comment from the reviewer:**\n" +
        "Please reapply once you have more building experience."
    );
  });

  it("is withheld when it is not flagged public", () => {
    const body = buildTicketMessage("denied", withComment({ commentIsPublic: false }));

    expect(body).toBe(DEFAULT_TICKET_MESSAGES.denied);
    expect(body).not.toContain("building experience");
  });

  it("defaults to withheld, so a caller that forgets the flag cannot leak one", () => {
    const body = buildTicketMessage("denied", withComment({}));
    expect(body).not.toContain("building experience");
  });

  it("is withheld on an approval too, when not flagged", () => {
    const body = buildTicketMessage("approved", withComment({ commentIsPublic: false }));
    expect(body).not.toContain("building experience");
  });

  it("is not posted with the opening message, which nobody has reviewed yet", () => {
    const body = buildTicketMessage(
      "pending",
      withComment({ commentIsPublic: true, reviewer: "Ben" })
    );

    expect(body).toBe(DEFAULT_TICKET_MESSAGES.pending);
    expect(body).not.toContain("building experience");
    expect(body).not.toContain("Ben");
  });

  it("is skipped when it is blank or only whitespace", () => {
    expect(buildTicketMessage("denied", { form: plainForm, comment: "  ", commentIsPublic: true }))
      .toBe(DEFAULT_TICKET_MESSAGES.denied);
    expect(buildTicketMessage("denied", { form: plainForm, comment: null, commentIsPublic: true }))
      .toBe(DEFAULT_TICKET_MESSAGES.denied);
  });
});

describe("the reviewer's name", () => {
  it("is named on a decision", () => {
    expect(buildTicketMessage("approved", { form: plainForm, reviewer: "Ben" })).toBe(
      `${DEFAULT_TICKET_MESSAGES.approved}\n\nReviewed by Ben.`
    );
  });

  it("is left out when it is not known", () => {
    expect(buildTicketMessage("approved", { form: plainForm })).toBe(
      DEFAULT_TICKET_MESSAGES.approved
    );
  });

  it("sits above the comment", () => {
    const body = buildTicketMessage("denied", {
      form: plainForm,
      reviewer: "Ben",
      comment: "Try again later.",
      commentIsPublic: true,
    });

    expect(body.indexOf("Reviewed by Ben.")).toBeLessThan(body.indexOf("Try again later."));
  });
});

describe("a form that is not reviewed at all", () => {
  it("does not promise an outcome that is never coming", () => {
    const received = buildTicketMessage("received", { form: plainForm });

    expect(received).toBe(DEFAULT_TICKET_MESSAGES.received);
    expect(received).not.toMatch(/review|outcome|decision/i);
    // The pending wording is the one that says staff will get back to you.
    expect(received).not.toBe(DEFAULT_TICKET_MESSAGES.pending);
  });

  it("still honours a per-form override, sharing the pending slot", () => {
    const form = { name: "Survey", ticketPendingMessage: "Thanks for the feedback!" };
    expect(buildTicketMessage("received", { form })).toBe("Thanks for the feedback!");
  });

  it("names nobody and publishes no comment", () => {
    const body = buildTicketMessage("received", {
      form: plainForm,
      reviewer: "Ben",
      comment: "internal",
      commentIsPublic: true,
    });

    expect(body).not.toContain("Ben");
    expect(body).not.toContain("internal");
  });
});

describe("a decision being undone", () => {
  it("does not reuse the wording that opens the ticket", () => {
    const reopened = buildTicketMessage("reopened", { form: wordedForm });

    expect(reopened).toBe(DEFAULT_TICKET_MESSAGES.reopened);
    expect(reopened).not.toBe(wordedForm.ticketPendingMessage);
  });

  it("names who did it but does not publish the comment", () => {
    const body = buildTicketMessage("reopened", {
      form: plainForm,
      reviewer: "Ben",
      comment: "internal note",
      commentIsPublic: true,
    });

    expect(body).toContain("Reviewed by Ben.");
    expect(body).not.toContain("internal note");
  });
});
