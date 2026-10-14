import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

// spec 09 §2 — semantic design tokens. Templates use these names only;
// raw palette literals are conscious exceptions (e.g. the cover
// placeholder's zinc gradient).
export default {
  content: ["./app/**/*.{vue,ts}"],
  theme: {
    extend: {
      colors: {
        primary: { ...colors.zinc, DEFAULT: colors.zinc[900] },
        page: colors.zinc[50],
        surface: colors.white,
        ink: colors.zinc[900],
        muted: colors.zinc[500],
        faint: colors.zinc[400],
        line: colors.zinc[200],
        success: colors.emerald,
        warning: colors.amber,
        danger: colors.red
      },
      fontFamily: {
        sans: [
          '"Inter Variable"',
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif"
        ]
      },
      boxShadow: {
        card: "0 1px 2px rgb(0 0 0 / 0.04), 0 2px 8px rgb(0 0 0 / 0.06)",
        "card-hover":
          "0 4px 12px rgb(0 0 0 / 0.08), 0 12px 28px rgb(0 0 0 / 0.1)"
      }
    }
  }
} satisfies Config;
