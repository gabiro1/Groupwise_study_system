import Link from "next/link";
import { InfoPage } from "../SiteLayout";

export const metadata = {
  title: "How Lien works",
  description: "See how to discover study groups and collaborate with classmates on Lien.",
};

const steps = [
  {
    number: "01",
    title: "Bring your courses into focus",
    description: "Choose the courses and topics you’re learning. They help shape relevant study-group recommendations.",
  },
  {
    number: "02",
    title: "Find your study people",
    description: "Explore groups connected to your learning interests, then join the people you want to learn alongside.",
  },
  {
    number: "03",
    title: "Plan time to meet",
    description: "Coordinate study sessions and make a plan together, whether you’re meeting in person or online.",
  },
  {
    number: "04",
    title: "Learn, share, and keep going",
    description: "Work through topics as a group, share progress, and give feedback so your study space keeps improving.",
  },
];

export default function HowItWorksPage() {
  return (
    <InfoPage
      eyebrow="YOUR STUDY FLOW"
      title={<>From “where do I start?”<br />to “we’ve got this.”</>}
      lead="Lien brings course-based group discovery and collaborative study tools into one place."
    >
      <ol className="info-steps">
        {steps.map((step) => (
          <li key={step.number}>
            <span className="info-step-number">{step.number}</span>
            <div><h2>{step.title}</h2><p>{step.description}</p></div>
          </li>
        ))}
      </ol>
      <section className="info-roles">
        <div><span className="info-overline">MADE FOR SHARED LEARNING</span><h2>A space for students to learn together.</h2><p>Students can discover groups, join a study space, coordinate sessions, and work through learning goals with peers.</p></div>
        <div><span className="info-overline">SUPPORTING THE CLASSROOM</span><h2>Course context helps everyone connect.</h2><p>Academic courses and topics give study groups a useful starting point, helping students find peers working on related material.</p></div>
      </section>
      <div className="info-callout"><p>Ready to find your people?</p><Link className="landing-primary-button" href="/dashboard/discover">Explore study groups <span aria-hidden="true">↗</span></Link></div>
    </InfoPage>
  );
}
