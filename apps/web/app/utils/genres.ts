/**
 * Suggestion list for the storefront genre filter (`<datalist>`). Genre is a
 * free-form string in the catalog — admins may create books in any genre —
 * so this list only seeds suggestions, it never restricts input.
 */
export const KNOWN_GENRES = [
  "fantasy",
  "sci-fi",
  "tech",
  "dystopia",
  "non-fiction"
] as const;
