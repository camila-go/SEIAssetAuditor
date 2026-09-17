/**
 * Palette for SEI Site Auditor.
 *
 * Replaces stock Tailwind `slate` + a generic navy. The old set had eight
 * competing hues where amber, yellow and orange all meant "caution" and both
 * blue and navy meant "brand", so colour carried no reliable meaning.
 *
 * Six ramps, each with exactly one job:
 *
 *   ink        neutrals — surfaces, borders, all body copy
 *   brand      primary actions, links, active nav, informational notices
 *   verified   published, approved, exact match — a confirmed good state
 *   caution    unknown, stale, needs review, awaiting a decision
 *   critical   failed, rejected, destructive
 *   structural not good or bad, but structurally notable — "Hardcoded"
 *
 * The neutrals carry a slight cool-violet cast rather than Tailwind's flat
 * grey-blue, so white cards read as a distinct surface instead of dissolving
 * into the page.
 *
 * Contrast (verified, not assumed) — every pairing below meets WCAG AA:
 *   ink-500 on white          4.99    smallest body text
 *   ink-600 on white          7.42
 *   brand-600 on white        9.32    links
 *   white on brand-600        9.32    primary button
 *   {hue}-800 on {hue}-100    8.8–10.6  badges
 *   {hue}-900 on {hue}-50     11.7–13.8 notices
 *
 * ink-400 is 2.95:1 and is therefore BORDERS AND ICONS ONLY — never text.
 * De-emphasised copy uses ink-500. The previous build used slate-400 for text
 * in six places, all of which failed AA.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f6f7f9',
          100: '#eceef2',
          200: '#d9dde5',
          300: '#bcc3d0',
          400: '#8d97a8',
          500: '#667082',
          600: '#4c5666',
          700: '#39424f',
          800: '#252c36',
          900: '#161b22',
          950: '#0c0f14',
        },
        brand: {
          50: '#eef1fa',
          100: '#dae1f4',
          200: '#b6c4e9',
          300: '#8a9fd9',
          400: '#5c78c4',
          500: '#3d59a8',
          600: '#2c428a',
          700: '#23346e',
          800: '#1c2a58',
          900: '#172244',
        },
        verified: {
          50: '#e8f6f1',
          100: '#cbeade',
          200: '#98d6bf',
          300: '#5dbb9c',
          400: '#2f9c7b',
          500: '#157f61',
          600: '#0d6650',
          700: '#0c5241',
          800: '#0b4135',
          900: '#09352c',
        },
        caution: {
          50: '#fdf3e4',
          100: '#fae5c4',
          200: '#f2c986',
          300: '#e5a948',
          400: '#cf8b1d',
          500: '#a96f12',
          600: '#875812',
          700: '#6b4514',
          800: '#553715',
          900: '#452d14',
        },
        critical: {
          50: '#fdefec',
          100: '#fbdcd6',
          200: '#f5b6ab',
          300: '#ec8878',
          400: '#dd5b47',
          500: '#c23c28',
          600: '#a12d1d',
          700: '#82241a',
          800: '#671e17',
          900: '#551b16',
        },
        structural: {
          50: '#f7eefa',
          100: '#efdcf5',
          200: '#dfb9ea',
          300: '#c98fd9',
          400: '#ad64c2',
          500: '#8e46a4',
          600: '#733786',
          700: '#5d2e6b',
          800: '#4b2756',
          900: '#3e2247',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      /**
       * Type scale.
       *
       * The problem this fixes: 20 of 28 headings were `text-sm` — the same
       * 14px as body copy — so every section heading relied on weight alone to
       * outrank the paragraph under it. There was no step between body and the
       * page title.
       *
       * `md` is the new rung that section headings sit on. Body stays at 14px
       * because this is a dense tool people read all day, and shrinking it to
       * buy hierarchy would have been the wrong trade.
       *
       * Every line-height is a multiple of 4 so text blocks land on the grid.
       */
      fontSize: {
        label: ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.08em' }], // 11/16 uppercase
        xs: ['0.75rem', { lineHeight: '1rem' }], //    12/16 meta
        sm: ['0.875rem', { lineHeight: '1.25rem' }], // 14/20 body — the workhorse
        md: ['1rem', { lineHeight: '1.5rem' }], //      16/24 section headings
        lg: ['1.125rem', { lineHeight: '1.5rem' }], //  18/24 card titles
        xl: ['1.375rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }], // 22/28 page titles
        '2xl': ['1.625rem', { lineHeight: '2rem', letterSpacing: '-0.015em' }], // 26/32
        '3xl': ['2rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em' }], //  32/36 stat figures
      },

      boxShadow: {
        // One soft, tinted elevation rather than Tailwind's neutral greys —
        // cards lift off the page without a hard drop shadow.
        card: '0 1px 2px rgba(22, 27, 34, 0.04), 0 1px 3px rgba(22, 27, 34, 0.06)',
      },
    },
  },
  plugins: [],
}
