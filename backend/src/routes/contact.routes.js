import { Router } from "express";
import { asyncHandler, created, ok } from "../lib/http.js";
import { ServiceUnavailableError } from "../lib/errors.js";
import { contactMessageSchema } from "../lib/schemas.js";
import { validate } from "../middleware/validate.js";
import { contactLimiter } from "../middleware/rateLimit.js";
import { sendMail } from "../services/mailer.js";
import env from "../config/env.js";

const router = Router();

router.get("/", (req, res) => ok(res, { csrfToken: req.csrfToken }));

router.post(
  "/",
  contactLimiter,
  validate({ body: contactMessageSchema }),
  asyncHandler(async (req, res) => {
    const { name, email, subject, message } = req.body;
    const result = await sendMail({
      to: env.SUPPORT_EMAIL,
      replyTo: email,
      subject: `Lien contact: ${subject}`,
      text: `From: ${name}\nEmail: ${email}\nSubject: ${subject}\n\n${message}`,
    });

    if (!result.delivered) {
      throw new ServiceUnavailableError(
        "We couldn’t send your message right now. Please try again later or email us directly.",
      );
    }

    return created(res, { message: "Thanks for reaching out. Your message has been sent." });
  }),
);

export default router;
