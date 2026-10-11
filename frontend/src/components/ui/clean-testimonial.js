"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { motion, useMotionValue, useSpring, AnimatePresence } from "framer-motion";

const testimonials = [
  {
    quote: "That topic felt impossible on Monday. By Friday, we had a plan and people to ask.",
    author: "Aaliyah Brooks",
    role: "Biochemistry student",
    company: "Northfield University",
    avatar:
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=400&q=80",
  },
  {
    quote: "Knowing when we’d meet made it easier to actually start, and that momentum changed everything.",
    author: "Marcus Lee",
    role: "Design major",
    company: "Creative Practice Lab",
    avatar:
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=400&q=80",
  },
  {
    quote: "We could see our progress, even when it was one small step at a time. That made the hard weeks feel manageable.",
    author: "Elena Park",
    role: "Computer science student",
    company: "Oakridge Institute",
    avatar:
      "https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?auto=format&fit=crop&w=400&q=80",
  },
];

function usePreloadImages(images) {
  useEffect(() => {
    images.forEach((src) => {
      const img = new Image();
      img.src = src;
    });
  }, [images]);
}

function SplitText({ text }) {
  const words = text.split(" ");

  return (
    <span className="inline">
      {words.map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.42, delay: i * 0.03, ease: [0.22, 1, 0.36, 1] }}
          className="mr-[0.28em] inline-block"
        >
          {word}
        </motion.span>
      ))}
    </span>
  );
}

export function Testimonial() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const containerRef = useRef(null);

  usePreloadImages(testimonials.map((item) => item.avatar));

  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const springConfig = { damping: 25, stiffness: 150 };
  const cursorX = useSpring(mouseX, springConfig);
  const cursorY = useSpring(mouseY, springConfig);

  const handleMouseMove = useCallback(
    (event) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      mouseX.set(event.clientX - rect.left);
      mouseY.set(event.clientY - rect.top);
    },
    [mouseX, mouseY]
  );

  const handleNext = () => {
    setActiveIndex((previous) => (previous + 1) % testimonials.length);
  };

  useEffect(() => {
    if (isHovered) return undefined;
    const intervalId = window.setInterval(() => {
      setActiveIndex((previous) => (previous + 1) % testimonials.length);
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [isHovered]);

  const currentTestimonial = testimonials[activeIndex];

  return (
    <div
      ref={containerRef}
      className="relative w-full max-w-5xl mx-auto"
      style={{ cursor: "none" }}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleNext}
    >
      <motion.div
        className="pointer-events-none absolute z-50 mix-blend-difference"
        style={{ x: cursorX, y: cursorY, translateX: "-50%", translateY: "-50%" }}
      >
        <motion.div
          className="flex items-center justify-center rounded-full bg-foreground"
          animate={{ width: isHovered ? 82 : 0, height: isHovered ? 82 : 0, opacity: isHovered ? 1 : 0 }}
          transition={{ type: "spring", damping: 22, stiffness: 200 }}
        >
          <motion.span
            className="text-[10px] font-medium uppercase tracking-[0.2em] text-background"
            animate={{ opacity: isHovered ? 1 : 0 }}
            transition={{ delay: 0.08 }}
          >
            Next
          </motion.span>
        </motion.div>
      </motion.div>

      <div className="clean-testimonial-card relative overflow-hidden rounded-[32px] p-6 sm:p-8 md:p-10">
        <div className="relative">
          <div className="mb-8 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
            <span className="inline-block size-2.5 rounded-full bg-[#1aa46e] shadow-[0_0_0_4px_rgba(26,164,110,0.16)]" />
            Testimonial
          </div>

          <div className="grid items-center gap-8">
            <div className="relative">
              <div className="mb-6 flex items-center justify-between">
                <div className="flex -space-x-2">
                  {testimonials.map((item, index) => (
                    <motion.div
                      key={item.author}
                      className={`relative h-9 w-9 overflow-hidden rounded-full border-2 border-background transition ${
                        index === activeIndex ? "ring-1 ring-[#cfe5d8] ring-offset-1 ring-offset-background" : "grayscale opacity-60"
                      }`}
                      whileHover={{ scale: 1.08, opacity: 1 }}
                    >
                      <img src={item.avatar || "/placeholder.svg"} alt={item.author} className="h-full w-full object-cover" />
                    </motion.div>
                  ))}
                </div>

                <div className="flex items-baseline gap-2 font-mono text-xs text-muted-foreground">
                  <motion.span
                    key={activeIndex}
                    initial={{ y: 10, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ duration: 0.28 }}
                    className="text-2xl font-light text-foreground"
                  >
                    {String(activeIndex + 1).padStart(2, "0")}
                  </motion.span>
                  <span>/</span>
                  <span>{String(testimonials.length).padStart(2, "0")}</span>
                </div>
              </div>

              <AnimatePresence mode="wait">
                <motion.blockquote
                  key={activeIndex}
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12, transition: { duration: 0.2 } }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="text-lg font-light leading-relaxed tracking-[-0.02em] text-foreground md:text-xl"
                >
                  <svg
                    aria-hidden="true"
                    className="mb-1 mr-2 inline-block h-5 w-5 align-top text-[#1aa46e]"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M7.17 6A5.17 5.17 0 0 0 2 11.17V18h8v-7H6.1a1.07 1.07 0 0 1 1.07-1.07H8V6h-.83Zm10 0A5.17 5.17 0 0 0 12 11.17V18h8v-7h-3.9a1.07 1.07 0 0 1 1.07-1.07H18V6h-.83Z" />
                  </svg>
                  <SplitText text={currentTestimonial.quote} />
                </motion.blockquote>
              </AnimatePresence>

              <AnimatePresence mode="wait">
                <motion.div
                  key={activeIndex}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={{ duration: 0.32 }}
                  className="mt-8 flex items-center gap-4"
                >
                  <div className="relative h-14 w-14 shrink-0">
                    <motion.div
                      className="absolute -inset-1.5 rounded-full border border-[#cfe5d8]"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.42 }}
                    />
                    <img
                      src={currentTestimonial.avatar}
                      alt={currentTestimonial.author}
                      className="absolute inset-0 h-14 w-14 rounded-full object-cover border border-white/80"
                    />
                  </div>

                  <div className="relative pl-4">
                    <div className="absolute inset-y-0 left-0 w-px bg-[#1aa46e]" />
                    <span className="block text-sm font-medium text-foreground md:text-base">{currentTestimonial.author}</span>
                    <span className="mt-1 block text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                      {currentTestimonial.role} — {currentTestimonial.company}
                    </span>
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>

          </div>

          <div className="mt-8 h-px overflow-hidden bg-[#e4ece7]">
            <motion.div
              className="h-full bg-[#1aa46e]"
              initial={{ width: "0%" }}
              animate={{ width: `${((activeIndex + 1) / testimonials.length) * 100}%` }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </div>
      </div>

    </div>
  );
}
