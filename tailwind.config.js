/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#0a0a0a", 900: "#121212", 800: "#1c1c1c", 700: "#2a2a2a", 600: "#3a3a3a", 400: "#8a8a8a", 300: "#b4b4b4" },
        cab: { 400: "#ffd84d", 500: "#f5c400", 600: "#d9ad00" },
      },
      fontFamily: { sans: ["Inter", "system-ui", "sans-serif"], mono: ["JetBrains Mono", "ui-monospace", "monospace"] },
    },
  },
  plugins: [],
};
