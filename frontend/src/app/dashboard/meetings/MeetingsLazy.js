"use client";

import dynamic from "next/dynamic";

const MeetingsLoaderInner = dynamic(() => import("./MeetingsLoader"), {
  ssr: false,
  loading: () => (
    <section className="section-page" aria-label="Loading meetings">
      <div className="meeting-skeleton"><div className="skeleton-tile" /><div className="skeleton-tile" /><div className="skeleton-tile" /></div>
    </section>
  ),
});

/** Code-split boundary: video code loads only when meetings open. */
export default function MeetingsLazy(props) {
  return <MeetingsLoaderInner {...props} />;
}
