/* Opening motion for the map's chrome (hazard bar, rail, date bar, legend) with GSAP, loaded from vendor/gsap.
 * Only the panels around the map move, never the map itself. Users who ask for reduced motion, and any page where
 * GSAP did not load, see the screen as it is with no animation. The motion runs once per page load. */

const CHROME = [".hazbar", ".rail", ".datebar", ".legendbar"];

export function playIntro() {
  const gsap = globalThis.gsap;
  if (!gsap) return;
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const targets = CHROME.map((s) => document.querySelector(s)).filter((el) => el && !el.hidden);
  if (!targets.length) return;

  gsap.from(targets, {
    opacity: 0,
    y: 14,
    duration: 0.7,
    ease: "power3.out",
    stagger: 0.09,
    clearProps: "transform,opacity", // leave no inline styles behind that would fight the page's own CSS transitions
  });
}
