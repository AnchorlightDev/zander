import dotenv from "dotenv";
import nodemailer from "nodemailer";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import { createGraphTransport } from "../lib/graphMail.mjs";
dotenv.config();

// emailTransport=graph sends through Microsoft Graph with an Entra app
// registration (works for shared mailboxes, no SMTP AUTH). Anything else, or
// unset, keeps the SMTP transport.
const emailTransport = String(process.env.emailTransport || "smtp").toLowerCase();

function createSmtpTransport() {
  const smtpPort = Number(process.env.smtpPort) || 587;
  const smtpSecure = String(process.env.smtpSecure || "").toLowerCase() === "true";
  const smtpRequireTLS = String(process.env.smtpRequireTLS || "true").toLowerCase() === "true";

  const smtp = nodemailer.createTransport({
    host: process.env.smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    requireTLS: !smtpSecure && smtpRequireTLS,
    auth: {
      user: process.env.smtpUser,
      pass: process.env.smtpPass,
    },
    tls: {
      minVersion: process.env.smtpTLSMinVersion || "TLSv1.2",
    },
  });
  smtp.describe = () =>
    `SMTP ${process.env.smtpHost}:${smtpPort} secure=${smtpSecure} requireTLS=${!smtpSecure && smtpRequireTLS}`;
  return smtp;
}

function createTransport() {
  if (emailTransport === "graph") {
    try {
      return createGraphTransport({
        tenantId: process.env.graphMailTenantId,
        clientId: process.env.graphMailClientId,
        clientSecret: process.env.graphMailClientSecret,
        sender: process.env.graphMailSender || process.env.smtpIdentityEmailAddress,
      });
    } catch (error) {
      console.error(`${error.message}. Email sending will fail until this is fixed.`);
      return {
        describe: () => "Microsoft Graph (misconfigured)",
        sendMail: async () => {
          throw error;
        },
      };
    }
  }
  return createSmtpTransport();
}

const transporter = createTransport();

console.info(`[EMAIL] Transport configured: ${transporter.describe()}`);

export async function sendMail(
  recipient,
  subject,
  template,
  templateData = {}
) {
  const templatePath = path.resolve(
    "views",
    "partials",
    "email",
    template
  );

  const templateContent = fs.readFileSync(templatePath, "utf-8");
  const renderedTemplate = ejs.render(templateContent, templateData);

  const mailOptions = {
    from: `"${process.env.smtpIdentityDisplayName}" <${process.env.smtpIdentityEmailAddress}>`,
    to: recipient,
    subject: subject,
    html: renderedTemplate,
  };

  try {
    console.info(
      `[EMAIL] Sending template "${template}" to ${recipient} via ${transporter.describe()}`
    );

    const info = await transporter.sendMail(mailOptions);

    const messageId = info?.messageId ? ` (messageId: ${info.messageId})` : "";
    console.info(
      `[EMAIL] Successfully sent template "${template}" to ${recipient}${messageId}`
    );

    if (info?.rejected?.length) {
      console.warn(
        `[EMAIL] Rejected the following recipients: ${info.rejected.join(", ")}`
      );
    }

    return info;
  } catch (error) {
    const message = error?.message || error;
    console.error(
      `[EMAIL] Failed to send template "${template}" to ${recipient}: ${message}`
    );

    if (error?.response) {
      console.error(`[EMAIL] Transport response: ${error.response}`);
    }

    throw error;
  }
}


/**
 * Send a pre-rendered HTML email without going through the EJS template layer.
 * Used by the global error reporter, which must not depend on view files and
 * needs to stay side-effect free (no throwing) for the caller.
 */
export async function sendRawMail(recipient, subject, html, { text } = {}) {
  const mailOptions = {
    from: `"${process.env.smtpIdentityDisplayName}" <${process.env.smtpIdentityEmailAddress}>`,
    to: recipient,
    subject,
    html,
    ...(text ? { text } : {}),
  };

  return transporter.sendMail(mailOptions);
}

export default transporter;
