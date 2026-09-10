'use client';

import { useEffect } from 'react';

/**
 * Adds `is-in` to every `.reveal` element as it enters the viewport.
 *
 * The elements are visible by default in CSS when motion is reduced, and the
 * observer only ever ADDS a class — so if JavaScript never runs, or the
 * observer is unsupported, nothing is left hidden. Content is never gated
 * behind an animation.
 */
export function useReveal() {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
    if (!nodes.length) return;

    if (typeof IntersectionObserver === 'undefined') {
      nodes.forEach((n) => n.classList.add('is-in'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
    );

    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);
}
