import Link from "next/link";
import { InfoPage } from "../SiteLayout";

export const metadata = {
  title: "Lien FAQs",
  description: "Answers to common questions about study groups and Lien.",
};

const questions = [
  {
    question: "What is Lien?",
    answer: "Lien is a collaborative study platform. It helps students discover study groups around their courses and topics, coordinate sessions, and learn with peers.",
  },
  {
    question: "Who is Lien for?",
    answer: "Lien is designed for students who want to study with classmates, find people working on similar material, and make learning a more shared experience.",
  },
  {
    question: "How do study-group recommendations work?",
    answer: "Recommendations use academic context such as courses and topics to surface relevant groups. What is available depends on the courses and groups set up for your institution.",
  },
  {
    question: "Do I need to meet in person?",
    answer: "Not necessarily. Study groups can coordinate sessions around the format that works for them, including online or in-person meetings.",
  },
  {
    question: "Can I create or manage a group study plan?",
    answer: "Group workspaces support shared plans, tasks, sessions, messages, and progress. Access depends on your membership in the study group.",
  },
  {
    question: "I can’t find my course or have an account issue. What should I do?",
    answer: "Course availability and account access may be managed by your institution. Contact us with your course or issue details and we’ll help point you in the right direction.",
  },
];

export default function FaqPage() {
  return (
    <InfoPage
      eyebrow="GOOD QUESTIONS"
      title="A few things you might be wondering."
      lead="A quick guide to how Lien brings courses, study groups, and shared sessions together."
    >
      <div className="faq-list">
        {questions.map((item) => (
          <details className="faq-item" key={item.question}>
            <summary>{item.question}<span aria-hidden="true">+</span></summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </div>
      <div className="info-callout"><p>Still have a question?</p><Link className="landing-primary-button" href="/contact">Get in touch <span aria-hidden="true">↗</span></Link></div>
    </InfoPage>
  );
}
