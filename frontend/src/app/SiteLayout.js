import Link from "next/link";
import BrandLogo from "./BrandLogo";
import SiteHeaderClient from "./SiteHeaderClient";

const pages = [
  { label: "Home", href: "/" },
  { label: "About", href: "/about" },
  { label: "How it works", href: "/how-it-works" },
  { label: "FAQs", href: "/faq" },
  { label: "Contact", href: "/contact" },
];

export function SiteHeader() {
  return <SiteHeaderClient pages={pages} />;
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-main">
        <div className="site-footer-brand">
          <Link className="landing-brand" href="/" aria-label="Lien home">
            <BrandLogo className="lien-logo" />
          </Link>
          <p>Helping students find their people, make time to learn, and move forward together.</p>
        </div>
        <div className="site-footer-column">
          <h2>Explore</h2>
          <nav aria-label="Explore Lien">
            <Link href="/about">About Lien</Link>
            <Link href="/how-it-works">How it works</Link>
            <Link href="/faq">Frequently asked questions</Link>
          </nav>
        </div>
        <div className="site-footer-column">
          <h2>Your study space</h2>
          <nav aria-label="Study space">
            <Link href="/dashboard/discover">Find a study group</Link>
            <Link href="/dashboard/groups">My study groups</Link>
            <Link href="/dashboard/sessions">Study sessions</Link>
            <Link href="/dashboard/courses">My courses</Link>
          </nav>
        </div>
        <div className="site-footer-column site-footer-contact">
          <h2>Get in touch</h2>
          <p>Questions or feedback? We’d be glad to hear from you.</p>
          <Link href="/contact">Contact us <span aria-hidden="true">↗</span></Link>
          <a href="mailto:jogabiro181@gmail.com">jogabiro181@gmail.com</a>
        </div>
      </div>
      <div className="site-footer-bottom">
        <span>© {new Date().getFullYear()} Lien. Made for learning, better together.</span>
        <Link href="/contact">Contact and support</Link>
      </div>
    </footer>
  );
}

export function InfoPage({ eyebrow, title, lead, children }) {
  return (
    <main className="landing-page">
      <SiteHeader />
      <article className="info-page">
        <header className="info-page-heading">
          <span>{eyebrow}</span>
          <h1>{title}</h1>
          <p>{lead}</p>
        </header>
        <div className="info-page-content">{children}</div>
      </article>
      <SiteFooter />
    </main>
  );
}
