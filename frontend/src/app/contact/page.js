import { InfoPage } from "../SiteLayout";
import ContactForm from "./ContactForm";

export const metadata = {
  title: "Contact Lien",
  description: "Get in touch with the Lien team.",
};

export default function ContactPage() {
  return (
    <InfoPage
      eyebrow="WE’RE HERE TO HELP"
      title="Let’s talk."
      lead="Questions, feedback, or something not working as expected? Send us a note and tell us how we can help."
    >
      <section className="contact-card contact-card-form">
        <div className="contact-card-heading">
          <div className="contact-icon" aria-hidden="true">@</div>
          <span className="info-overline">SEND US A MESSAGE</span>
          <h2>Tell us what’s on your mind.</h2>
          <p>For help with your account or course, include your institution and course name.</p>
        </div>
        <ContactForm />
      </section>
      <p className="contact-note">Prefer email? Reach us at <a href="mailto:jogabiro181@gmail.com">jogabiro181@gmail.com</a>.</p>
    </InfoPage>
  );
}
