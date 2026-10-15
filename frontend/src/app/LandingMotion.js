"use client";

import { motion } from "framer-motion";
import { useInView } from "framer-motion";
import { useRef, useSyncExternalStore } from "react";

const riseIn = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0 },
};

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange) {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot() {
  return typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Hydration-safe reduced-motion flag.
 *
 * `useReducedMotion()` reads `window.matchMedia`, which is unavailable during
 * SSR, so the server always renders the non-reduced variant while the client
 * may immediately render the reduced one — a hydration mismatch.
 * `useSyncExternalStore` uses the server snapshot (`false`) for the hydration
 * render, then switches to the real client value, keeping both renders in sync.
 */
function useMotionPreference() {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot, () => false);
}

export function Reveal({ children, className, delay = 0, inView = true }) {
  const reduceMotion = useMotionPreference();
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.05 });
  const visible = { opacity: 1, y: 0 };

  return (
    <motion.div
      ref={ref}
      className={className}
      initial={reduceMotion ? { opacity: 0, y: 0 } : "hidden"}
      animate={reduceMotion
        ? visible
        : !inView || isInView ? "visible" : "hidden"}
      variants={reduceMotion ? undefined : riseIn}
      transition={{ duration: reduceMotion ? 0.28 : 0.72, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function AnimatedSection({ children, className, id, label, initial = false }) {
  const reduceMotion = useMotionPreference();
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.05 });
  const visible = { opacity: 1, y: 0 };

  return (
    <motion.section
      ref={ref}
      className={className}
      id={id}
      aria-label={label}
      initial={reduceMotion ? { opacity: 0, y: 0 } : "hidden"}
      animate={reduceMotion
        ? visible
        : initial || isInView ? "visible" : "hidden"}
      variants={reduceMotion ? undefined : riseIn}
      transition={{ duration: reduceMotion ? 0.28 : 0.76, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.section>
  );
}

export function StaggerGroup({ children, className, id }) {
  return <div className={className} id={id}>{children}</div>;
}

export function StaggerItem({ children, className, delay = 0 }) {
  const reduceMotion = useMotionPreference();
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.05 });
  return (
    <motion.article
      ref={ref}
      className={className}
      initial={reduceMotion ? { opacity: 0, y: 0 } : "hidden"}
      animate={reduceMotion ? { opacity: 1, y: 0 } : isInView ? "visible" : "hidden"}
      variants={reduceMotion ? undefined : riseIn}
      whileHover={reduceMotion ? undefined : { y: -5, transition: { duration: 0.2 } }}
      transition={{ duration: reduceMotion ? 0.28 : 0.68, delay: reduceMotion ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.article>
  );
}
