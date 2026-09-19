import type { Config } from 'tailwindcss';

export default {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-elevated': 'var(--bg-elevated)',
        'bg-card': 'var(--bg-card)',
        'bg-card-solid': 'var(--bg-card-solid)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        text: 'var(--text)',
        'text-muted': 'var(--text-muted)',
        'text-subtle': 'var(--text-subtle)',
        accent: 'var(--accent)',
        'accent-2': 'var(--accent-2)',
        'accent-3': 'var(--accent-3)',
        success: 'var(--success)',
        'success-fg': 'var(--success-fg)',
        warning: 'var(--warning)',
        'warning-fg': 'var(--warning-fg)',
        danger: 'var(--danger)',
        'danger-fg': 'var(--danger-fg)',
        info: 'var(--info)',
        'info-fg': 'var(--info-fg)',
        // Editorial skin — Blueprint Edition
        'ed-canvas': 'var(--ed-canvas)',
        'ed-canvas-2': 'var(--ed-canvas-2)',
        'ed-panel': 'var(--ed-panel)',
        'ed-ink': 'var(--ed-ink)',
        'ed-ink-soft': 'var(--ed-ink-soft)',
        'ed-ink-faint': 'var(--ed-ink-faint)',
        'ed-rule': 'var(--ed-rule)',
        'ed-rule-strong': 'var(--ed-rule-strong)',
        'ed-accent-gold': 'var(--ed-accent-gold)',
        'ed-accent-gold-dim': 'var(--ed-accent-gold-dim)',
        'ed-accent-gold-strong': 'var(--ed-accent-gold-strong)',
        'ed-status-ok': 'var(--ed-status-ok)',
        'ed-status-warn': 'var(--ed-status-warn)',
        'ed-status-alert': 'var(--ed-status-alert)',
        'ed-status-neutral': 'var(--ed-status-neutral)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'monospace'],
        // Editorial skin — Blueprint Edition
        editorial: ['var(--font-editorial)', 'ui-serif', 'Georgia', 'serif'],
        'inter-tight': ['var(--font-inter-tight)', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        md: 'var(--radius)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        'ed-hairline': 'var(--ed-radius-hairline)',
        'ed-chip': 'var(--ed-radius-chip)',
        'ed-card': 'var(--ed-radius-card)',
        'ed-pill': 'var(--ed-radius-pill)',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        glow: 'var(--glow)',
        'glow-violet': 'var(--glow-violet)',
        'glow-emerald': 'var(--glow-emerald)',
        // Editorial skin — apenas para flutuantes
        'ed-popover': 'var(--ed-shadow-popover)',
        'ed-hover': 'var(--ed-shadow-hover)',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        editorial: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        orbDrift: {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '50%': { transform: 'translate(40px, -20px)' },
        },
        // Editorial skin keyframes
        edFadeIn: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        edPulseGold: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(203, 166, 90, 0.35)' },
          '50%': { boxShadow: '0 0 0 8px rgba(203, 166, 90, 0)' },
        },
      },
      animation: {
        'in': 'fadeInUp 450ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'shimmer': 'shimmer 1.6s linear infinite',
        'orb': 'orbDrift 14s ease-in-out infinite',
        // Editorial skin animations
        'ed-fade': 'edFadeIn 240ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'ed-pulse-gold': 'edPulseGold 2.4s cubic-bezier(0.2, 0.8, 0.2, 1) infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
} satisfies Config;