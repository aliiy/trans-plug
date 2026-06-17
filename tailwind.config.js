/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: 'rgba(255,255,255,0.04)',
        'surface-hover': 'rgba(255,255,255,0.07)',
        border: 'rgba(255,255,255,0.06)',
        'border-strong': 'rgba(255,255,255,0.10)',
        accent: '#6366f1',
        'accent-soft': 'rgba(99,102,241,0.12)',
        'accent-glow': 'rgba(99,102,241,0.25)',
      },
      backdropBlur: {
        xs: '2px',
      },
      boxShadow: {
        'soft': '0 1px 2px rgba(0,0,0,0.3), 0 2px 8px rgba(0,0,0,0.2)',
        'card': '0 0 0 1px rgba(255,255,255,0.04), 0 1px 3px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.3)',
        'glow': '0 0 0 1px rgba(99,102,241,0.3), 0 0 12px rgba(99,102,241,0.12)',
      },
      animation: {
        'in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.25s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
