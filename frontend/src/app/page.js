import Link from "next/link";
import { SiteFooter, SiteHeader } from "./SiteLayout";
import { AnimatedSection, Reveal, StaggerGroup, StaggerItem } from "./LandingMotion";
import { Testimonial } from "@/components/ui/clean-testimonial";

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

const features = [
  {
    icon: "◉",
    tone: "feature-card-green",
    eyebrow: "FIND YOUR PEOPLE",
    title: "Study with people who get it.",
    description: "Discover study groups around the courses, topics, and goals you care about.",
    href: "/dashboard/discover",
    link: "Explore study groups",
  },
  {
    icon: "◷",
    tone: "feature-card-yellow",
    eyebrow: "MAKE A PLAN",
    title: "Turn good intentions into a rhythm.",
    description: "Make a shared plan, break it into tasks, and find a time to meet.",
    href: "/dashboard/sessions",
    link: "See study sessions",
  },
  {
    icon: "▤",
    tone: "feature-card-blue",
    eyebrow: "KEEP LEARNING",
    title: "Make progress visible.",
    description: "Share resources, check in on topics, and celebrate what your group has learned.",
    href: "/dashboard/groups",
    link: "Explore your study space",
  },
];

const questions = [
  {
    question: "What is Lien?",
    answer: "Lien helps students find study groups around their courses and topics, coordinate study sessions, and learn together.",
  },
  {
    question: "How are study groups recommended?",
    answer: "Recommendations use the courses, topics, availability, and study preferences you choose to share. Matches are suggestions, and you decide whether to join.",
  },
  {
    question: "What can I do in a group workspace?",
    answer: "Group workspaces bring study plans, tasks, sessions, chat, shared resources, and progress updates together in one place.",
  },
  {
    question: "Is the AI study assistant always available?",
    answer: "AI availability depends on the service configuration. When available, the workspace assistant is designed to answer from accessible group material and discussion; if there isn’t enough context, it should say so.",
  },
  {
    question: "Do I have to meet in person?",
    answer: "No. Groups can coordinate online or in-person sessions, depending on what works for their members.",
  },
];

export default function Home() {
  return (
    <main className="landing-page landing-home">
      <SiteHeader />

      <section className="landing-hero home-hero">
        <Reveal className="landing-hero-copy" inView={false}>
          <div className="landing-pill"><span /> A little better, together</div>
          <h1>Learning feels<br />lighter <span>together.</span></h1>
          <p>Find your people, make time to study, and turn the hard parts of learning into something you can share.</p>
          <div className="landing-hero-actions">
            <Link className="landing-primary-button" href="/register">Find your study crew <Arrow /></Link>
            <a className="landing-text-link" href="#how-it-works">See how it works <span aria-hidden="true">↓</span></a>
          </div>
          <div className="landing-social-proof">
            <div className="landing-avatar-stack" aria-label="A group of study buddies">
              <span className="landing-avatar" tabIndex={0} role="img" aria-label="Study buddy">
                <img src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=96&h=96&q=80" alt="" />
                <span className="landing-avatar-tooltip" aria-hidden="true">Study buddy</span>
              </span>
              <span className="landing-avatar" tabIndex={0} role="img" aria-label="Course mate">
                <img src="https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=96&h=96&q=80" alt="" />
                <span className="landing-avatar-tooltip" aria-hidden="true">Course mate</span>
              </span>
              <span className="landing-avatar" tabIndex={0} role="img" aria-label="Study partner">
                <img src="https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?auto=format&fit=crop&w=96&h=96&q=80" alt="" />
                <span className="landing-avatar-tooltip" aria-hidden="true">Study partner</span>
              </span>
              <span className="landing-avatar" tabIndex={0} role="img" aria-label="Group member">
                <img src="https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=96&h=96&q=80" alt="" />
                <span className="landing-avatar-tooltip" aria-hidden="true">Group member</span>
              </span>
            </div>
            <div><strong>Good things happen in good company.</strong><small>Make a little progress, together.</small></div>
          </div>
        </Reveal>
        <div className="home-hero-orbit" aria-hidden="true">
          <span className="home-orbit-dot orbit-dot-one" />
          <span className="home-orbit-dot orbit-dot-two" />
          <span className="home-orbit-dot orbit-dot-three" />
        </div>
      </section>

      <AnimatedSection className="home-section home-how" id="how-it-works" label="How Lien works">
        <Reveal className="home-section-heading">
          <span>HOW IT WORKS</span>
          <h2>From “I should study”<br />to “we’ve got this.”</h2>
          <p>A few small steps can make studying feel a lot more doable.</p>
        </Reveal>
        <StaggerGroup className="home-steps">
          <StaggerItem className="home-step">
            <span className="home-step-number">01</span>
            <span className="home-step-icon">◎</span>
            <h3>Tell us what you’re learning</h3>
            <p>Add your courses, topics, and the way you like to study. Share only what you’re comfortable sharing.</p>
          </StaggerItem>
          <StaggerItem className="home-step">
            <span className="home-step-number">02</span>
            <span className="home-step-icon">○</span>
            <h3>Find a group that fits</h3>
            <p>Explore relevant study groups and see why a group may suit your learning goals.</p>
          </StaggerItem>
          <StaggerItem className="home-step">
            <span className="home-step-number">03</span>
            <span className="home-step-icon">↗</span>
            <h3>Make progress together</h3>
            <p>Plan a session, share resources, and keep the next small step in reach.</p>
          </StaggerItem>
        </StaggerGroup>
      </AnimatedSection>

      <AnimatedSection className="home-section home-features-section" id="features" label="Lien features">
        <Reveal className="home-section-heading">
          <span>MADE FOR REAL STUDY LIFE</span>
          <h2>Everything works better<br />when it works together.</h2>
          <p>Find your group, plan your time, and keep the learning moving—all in one calm space.</p>
        </Reveal>
        <StaggerGroup className="landing-feature-grid home-feature-grid">
          {features.map((feature, index) => (
            <StaggerItem className={`landing-feature-card ${feature.tone}`} delay={index * 0.08} key={feature.eyebrow}>
              <span className="feature-icon">{feature.icon}</span>
              <small>{feature.eyebrow}</small>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
              <Link href={feature.href}>{feature.link} <Arrow /></Link>
            </StaggerItem>
          ))}
        </StaggerGroup>
      </AnimatedSection>

      <AnimatedSection className="home-ai-section" id="ai-tutor" label="AI study assistant">
        <div className="home-ai-inner">
          <Reveal className="home-ai-copy">
            <span className="home-section-kicker">A STUDY PARTNER FOR THE STICKY BITS</span>
            <h2>Meet your AI<br />study assistant.</h2>
            <p>Ask questions about the material your group has shared. When the assistant is available, it uses relevant study resources and discussion to ground its answers.</p>
            <ul>
              <li><span>✓</span> Answers grounded in accessible group material</li>
              <li><span>✓</span> Sources shown alongside responses</li>
              <li><span>✓</span> Honest when there isn’t enough context</li>
            </ul>
            <Link className="landing-primary-button" href="/register">Study with Lien <Arrow /></Link>
            <small className="home-ai-note">AI availability depends on service configuration.</small>
          </Reveal>
          <Reveal className="home-ai-visual" delay={0.12}>
            <div className="home-ai-window">
              <div className="home-ai-window-top"><span><i /> Lien study assistant</span><small>GROUP MATERIAL</small></div>
              <div className="home-ai-question"><span>YOU</span><p>Can you help us review the topic we shared?</p></div>
              <div className="home-ai-answer">
                <span className="home-ai-avatar" aria-hidden="true">?</span>
                <div><strong>Let’s work through it together.</strong><p>I’ll look at your group’s shared notes and discussion first, then point out what they cover.</p><small>↗ Based on a resource shared with your group</small></div>
              </div>
              <div className="home-ai-input"><span>Ask about your group’s material…</span><b>↑</b></div>
            </div>
            <span className="home-ai-float">Learn at your own pace</span>
          </Reveal>
        </div>
      </AnimatedSection>

      <AnimatedSection className="home-section home-tools-section" id="study-tools" label="Study tools">
        <Reveal className="home-section-heading">
          <span>YOUR SHARED STUDY TOOLKIT</span>
          <h2>A place for all the pieces<br />of learning together.</h2>
          <p>Keep the practical details close, so your group can focus on the learning.</p>
        </Reveal>
        <StaggerGroup className="home-tools-grid">
          <StaggerItem className="home-tool-card">
            <span className="home-tool-icon tool-mint">▤</span><h3>Shared study plans</h3><p>Agree on what to cover and give your next study session a purpose.</p>
          </StaggerItem>
          <StaggerItem className="home-tool-card">
            <span className="home-tool-icon tool-peach">✓</span><h3>Friendly task lists</h3><p>Break a big topic into small actions your group can work through.</p>
          </StaggerItem>
          <StaggerItem className="home-tool-card">
            <span className="home-tool-icon tool-lilac">◷</span><h3>Study sessions</h3><p>Schedule a time, choose online or in person, and let your group RSVP.</p>
          </StaggerItem>
          <StaggerItem className="home-tool-card">
            <span className="home-tool-icon tool-yellow">↗</span><h3>Resources and chat</h3><p>Share useful links or notes and keep the conversation in your group space.</p>
          </StaggerItem>
        </StaggerGroup>
      </AnimatedSection>

      <AnimatedSection className="home-section home-stories-section" id="testimonials" label="Testimonial">
        <Reveal className="home-section-heading">
          <span>SMALL WINS WORTH SHARING</span>
          <h2>Learning can feel different<br />when you do it together.</h2>
          <p></p>
        </Reveal>
        <div className="home-testimonial-shell">
          <Testimonial />
        </div>
      </AnimatedSection>

      <AnimatedSection className="home-section home-faq-section" id="faq" label="Frequently asked questions">
        <div className="home-faq-layout">
          <Reveal className="home-faq-heading">
            <span className="home-section-kicker">GOOD QUESTIONS</span>
            <h2>A few things<br />you might be<br />wondering.</h2>
            <p>Need a little more help? We’re happy to hear from you.</p>
            <Link className="home-text-cta" href="/contact">Contact us <Arrow /></Link>
          </Reveal>
          <div className="home-faq-list">
            {questions.map((item, index) => (
              <Reveal className="home-faq-item-wrap" delay={index * 0.04} key={item.question}>
                <details className="home-faq-item">
                  <summary>{item.question}<span aria-hidden="true">+</span></summary>
                  <p>{item.answer}</p>
                </details>
              </Reveal>
            ))}
            <Link className="home-all-faq" href="/faq">See all frequently asked questions <Arrow /></Link>
          </div>
        </div>
      </AnimatedSection>

      <AnimatedSection className="landing-bottom-cta home-final-cta" id="final-cta" label="Get started with Lien">
        <div><span>YOUR NEXT CHAPTER STARTS HERE</span><h2>Better days of learning<br />start with one hello.</h2><p>Find your people and take the first small step together.</p></div>
        <Link className="landing-primary-button" href="/register">Come study with us <Arrow /></Link>
      </AnimatedSection>

      <SiteFooter />
    </main>
  );
}
