/**
 * Target languages for ⌘⇧T, plus the ones used most recently, so the usual
 * choice is preselected and one Enter away. Any typed name works too.
 */
export const LANGUAGES = [
  "English",
  "German",
  "Turkish",
  "French",
  "Spanish",
  "Italian",
  "Portuguese",
  "Dutch",
  "Polish",
  "Swedish",
  "Danish",
  "Norwegian",
  "Finnish",
  "Czech",
  "Greek",
  "Russian",
  "Ukrainian",
  "Arabic",
  "Hebrew",
  "Hindi",
  "Japanese",
  "Korean",
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "Indonesian",
  "Vietnamese",
  "Thai",
];

const KEY = "translate.recent";
const KEEP = 4;

export function recentLanguages(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

export function rememberLanguage(language: string) {
  const next = [language, ...recentLanguages().filter((l) => l !== language)].slice(0, KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* just won't be remembered */
  }
}
