import type { Config } from 'tailwindcss';

// Every colour is a CSS variable defined in globals.css, so light and dark are
// the same component tree with a different token set — they cannot drift apart,
// and no component ever names a raw hex.
//
// Colour semantics (see globals.css for the full rule):
//   pos = credit/settled · neg = debit/reverted · held = escrowed/pending
//   brand = interactive fill, a neutral. Off-venue links carry no hue.
// Tokens are space-separated RGB channels so Tailwind's opacity modifiers work
// on them: bg-pos/10 and border-held/40 resolve properly. A hex inside var()
// would silently render fully opaque and turn every wash into a solid block.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ground: token('ground'),
        panel: token('panel'),
        raised: token('raised'),
        line: token('line'),
        lineBright: token('line-bright'),

        txt: token('txt'),
        muted: token('muted'),
        dim: token('dim'),

        pos: token('pos'),
        neg: token('neg'),
        held: token('held'),

        posWash: 'rgb(var(--pos) / 0.10)',
        negWash: 'rgb(var(--neg) / 0.10)',
        heldWash: 'rgb(var(--held) / 0.12)',

        brand: token('brand'),
        brandTxt: token('brand-txt'),
      },
      fontFamily: {
        // Humanist, open apertures, smooth terminals — readable at 12px in a
        // dense table and still confident at 44px in a headline. Deliberately
        // not Inter or Roboto.
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderWidth: {
        DEFAULT: '5px',
        2: '5px',
        4: '5px',
      },
      boxShadow: {
        panel: 'var(--shadow)',
      },
      keyframes: {
        flashPos: { '0%': { backgroundColor: 'rgb(var(--pos) / 0.18)' }, '100%': { backgroundColor: 'transparent' } },
        flashNeg: { '0%': { backgroundColor: 'rgb(var(--neg) / 0.18)' }, '100%': { backgroundColor: 'transparent' } },
        unlock: { '0%': { transform: 'translateY(-2px) rotate(-8deg)', opacity: '0' }, '100%': { transform: 'none', opacity: '1' } },
        pulseDot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
        slideIn: { '0%': { opacity: '0', transform: 'translateY(4px)' }, '100%': { opacity: '1', transform: 'none' } },

        // Settlement: the two legs cross in the same instant and land together.
        legRight: {
          '0%': { transform: 'translateX(0)', opacity: '0' },
          '12%': { opacity: '1' },
          '88%': { opacity: '1' },
          '100%': { transform: 'translateX(var(--leg-travel, 150px))', opacity: '0' },
        },
        legLeft: {
          '0%': { transform: 'translateX(0)', opacity: '0' },
          '12%': { opacity: '1' },
          '88%': { opacity: '1' },
          '100%': { transform: 'translateX(calc(-1 * var(--leg-travel, 150px)))', opacity: '0' },
        },
        // A reverted leg sets off, then is pulled back to where it started.
        legRecoil: {
          '0%': { transform: 'translateX(0)', opacity: '0' },
          '15%': { opacity: '1' },
          '45%': { transform: 'translateX(calc(var(--leg-travel, 150px) * 0.42))', opacity: '1' },
          '70%': { transform: 'translateX(0)', opacity: '1' },
          '100%': { transform: 'translateX(0)', opacity: '0' },
        },
        settleLand: {
          '0%': { transform: 'scale(0.94)', opacity: '0.4' },
          '60%': { transform: 'scale(1.03)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
      animation: {
        flashPos: 'flashPos 900ms ease-out',
        flashNeg: 'flashNeg 900ms ease-out',
        unlock: 'unlock 320ms ease-out',
        pulseDot: 'pulseDot 1.6s ease-in-out infinite',
        slideIn: 'slideIn 240ms ease-out',
        legRight: 'legRight 1600ms cubic-bezier(0.4, 0, 0.2, 1) infinite',
        legLeft: 'legLeft 1600ms cubic-bezier(0.4, 0, 0.2, 1) infinite',
        legRecoil: 'legRecoil 1900ms cubic-bezier(0.4, 0, 0.2, 1) infinite',
        settleLand: 'settleLand 420ms cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
} satisfies Config;
