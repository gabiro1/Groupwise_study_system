"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger);
}

export default function LandingHeroAnimation({ children }) {
  const sectionRef = useRef(null);
  const pointerFrame = useRef(0);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hasFinePointer = window.matchMedia("(pointer: fine)").matches;
    let removePointerListeners = () => {};

    const context = gsap.context(() => {
      const items = ".landing-hero-motion-item";
      if (reduceMotion) {
        gsap.set(items, { clearProps: "all", autoAlpha: 1 });
        return;
      }

      gsap.fromTo(
        items,
        { autoAlpha: 0, y: 22, filter: "blur(8px)" },
        { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.7, delay: 0.12, stagger: 0.08, ease: "power3.out" },
      );

      const orbit = section.querySelector(".home-hero-orbit");
      if (hasFinePointer && orbit) {
        const moveX = gsap.quickTo(orbit, "--orbit-x", { duration: 0.8, ease: "power3.out" });
        const moveY = gsap.quickTo(orbit, "--orbit-y", { duration: 0.8, ease: "power3.out" });
        const handlePointerMove = (event) => {
          cancelAnimationFrame(pointerFrame.current);
          pointerFrame.current = requestAnimationFrame(() => {
            const x = (event.clientX / window.innerWidth - 0.5) * 18;
            const y = (event.clientY / window.innerHeight - 0.5) * 14;
            moveX(`${x}px`);
            moveY(`${y}px`);
          });
        };
        const handlePointerLeave = () => {
          moveX("0px");
          moveY("0px");
        };

        section.addEventListener("pointermove", handlePointerMove);
        section.addEventListener("pointerleave", handlePointerLeave);
        removePointerListeners = () => {
          section.removeEventListener("pointermove", handlePointerMove);
          section.removeEventListener("pointerleave", handlePointerLeave);
          cancelAnimationFrame(pointerFrame.current);
        };
      }

      gsap.timeline({
        scrollTrigger: {
          trigger: section,
          start: "top top",
          end: "+=820",
          scrub: 1,
        },
      })
        .to(".landing-hero-copy", { y: -65, scale: 0.96, autoAlpha: 0.82, duration: 1, ease: "power2.out" }, 0)
        .to(".home-hero-orbit", { "--orbit-y": "64px", "--orbit-rotation": "14deg", autoAlpha: 0.55, duration: 1, ease: "none" }, 0)
        .to(".landing-social-proof", { y: -18, autoAlpha: 0.65, duration: 0.5, ease: "power2.out" }, 0.2);
    }, section);

    return () => {
      removePointerListeners();
      context.revert();
    };
  }, []);

  return (
    <section ref={sectionRef} className="landing-hero home-hero landing-hero-gsap">
      {children}
    </section>
  );
}
