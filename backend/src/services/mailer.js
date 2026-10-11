import nodemailer from "nodemailer";
import env from "../config/env.js";
import logger from "../config/logger.js";

/**
 * Transactional email.
 *
 * SMTP is optional. When it is unavailable, callers receive an explicit
 * delivery failure and may provide a safe environment-specific fallback.
 */

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (env.RESEND_API_KEY) {
    transporter = nodemailer.createTransport({
      host: "smtp.resend.com",
      port: 465,
      secure: true,
      auth: { user: "resend", pass: env.RESEND_API_KEY },
    });
    return transporter;
  }

  if (!env.SMTP_HOST || !env.SMTP_PORT) {
    logger.info("SMTP is not configured; emails will be logged instead of sent", {
      from: env.SMTP_FROM,
      hint: "Set SMTP_HOST and SMTP_PORT to send real email.",
    });
    return null;
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });

  return transporter;
}

/**
 * @param {{to:string, subject:string, text:string, html?:string, replyTo?:string}} message
 * @returns {Promise<{delivered:boolean, reason?:string}>}
 */
export async function sendMail({ to, subject, text, html, replyTo }) {
  const transport = getTransporter();

  if (!transport) {
    logger.info("Email (not sent — no SMTP configured)", {
      to,
      subject,
    });
    return { delivered: false, reason: "smtp_not_configured" };
  }

  try {
    await transport.sendMail({ from: env.SMTP_FROM, to, subject, text, html, replyTo });
    logger.info("Email sent", { to, subject });
    return { delivered: true };
  } catch (error) {
    // Never surface SMTP internals to the user.
    logger.error("Email delivery failed", { to, subject, message: error.message, code: error.code });
    return { delivered: false, reason: "smtp_error" };
  }
}

export default { sendMail };