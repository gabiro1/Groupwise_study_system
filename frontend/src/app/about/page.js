import Link from "next/link";
import { InfoPage } from "../SiteLayout";

export const metadata = {
  title: "About Lien",
  description: "Learn why Lien brings students together to study.",
};

export default function AboutPage() {
  return (
    <InfoPage
      eyebrow="A LITTLE BETTER, TOGETHER"
      title={<>Learning is easier<br />when we learn together.</>}
      lead="Lien helps students find the right people to study with, make time to learn, and keep moving forward as a group."
    >
      <section className="info-story">
        <div>
          <span className="info-overline">WHY WE’RE HERE</span>
          <h2>Studying shouldn’t feel like doing it all alone.</h2>
        </div>
        <div>
          <p>Some ideas click when you talk them through. Some goals are easier to keep when someone else is counting on you. Lien is designed to make those moments easier to find.</p>
          <p>Bring your courses and learning goals together with other students, plan a time to meet, and build a steady study rhythm—one session at a time.</p>
        </div>
      </section>
      <section className="info-values">
        <article><span>01</span><h3>Start with shared learning</h3><p>Find people around the courses and topics you’re working on.</p></article>
        <article><span>02</span><h3>Make space for progress</h3><p>Use study groups, plans, and sessions to turn good intentions into time spent learning.</p></article>
        <article><span>03</span><h3>Keep it collaborative</h3><p>Share the work, encourage one another, and make learning feel more connected.</p></article>
      </section>
      <div className="info-callout"><p>Curious what that looks like in practice?</p><Link className="landing-primary-button" href="/how-it-works">See how Lien works <span aria-hidden="true">↗</span></Link></div>
    </InfoPage>
  );
}
