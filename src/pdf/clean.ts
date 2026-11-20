/**
 * Turns raw PDF sentence text into something pleasant to listen to:
 * no URLs, citation markers, bullets, stray dashes/slashes, trademark marks,
 * dot leaders or markup characters. Punctuation that only creates a pause is
 * normalised to a comma so the voice breathes instead of saying "dash".
 */
export function cleanForSpeech(input: string): string {
  let s = input;

  s = s
    .replace(/\s+/g, " ")
    // Links and file paths read terribly
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\b\S+\.(?:pdf|html?|php|aspx?)\b/gi, " ")
    // Citation markers: [1] [2, 5] [3–7] and superscript-style ¹²³
    .replace(/\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/g, " ")
    .replace(/[¹²³⁰-₟]/g, "")
    // Marks nobody wants read aloud
    .replace(/[®™©℠°†‡¶※]/g, "")
    .replace(/§+/g, " section ")
    .replace(/&/g, " and ")
    .replace(/(\d)\s*%/g, "$1 percent")
    // Number ranges: 2010–2020, pp. 10–12  →  "2010 to 2020"
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")
    // Slashes: keep fractions and dates (1/2, 12/05/2024); otherwise a soft break
    .replace(/(?<=\p{L})\/(?=\p{L})/gu, " ")
    .replace(/(?<!\d)\/|\/(?!\d)/g, " ")
    // Dot leaders in tables of contents, ellipses
    .replace(/(?:\s*\.){3,}\s*\d{1,4}\b/g, ". ") // table-of-contents leader + page number
    .replace(/(?:\s*\.){3,}|…/g, ", ")
    // Bullets, arrows, check marks and other list glyphs
    .replace(/[•·◦▪▫■□●○◆◇►▶▸▹➢➤➔→←↑↓✓✔✗✘★☆❖⦿⁃∙]/g, ", ")
    // Dashes used as punctuation (standalone, or em/en dash between words) → pause
    .replace(/(^|\s)[-–—‒―]+(?=\s|$)/g, "$1, ")
    .replace(/(\p{L})\s*[–—―]\s*(?=\p{L})/gu, "$1, ")
    // Leading list markers: "- item", "* item", "a) item", "1) item"
    .replace(/^\s*(?:[-*+>]+|\(?[a-z0-9]\))\s+/i, "")
    // Markup / decorative characters
    .replace(/[_*#~^|\\<>{}[\]=`"“”„«»]/g, " ")
    // Empty brackets left behind
    .replace(/\(\s*[,;]?\s*\)/g, " ")
    // Tidy punctuation and spacing
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/,(\s*[.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:)]+/, "")
    .replace(/[\s,;:(]+$/, "")
    .trim();

  return s;
}

/** True when a line is only a page number ("12", "- 12 -", "Page 3 of 10", "iv"). */
export function isPageNumber(line: string): boolean {
  const t = line.trim();
  return (
    /^[-–—\s]*(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?[-–—\s]*$/i.test(t) ||
    /^[-–—\s]*[ivxl]{1,6}[-–—\s]*$/.test(t) // lowercase roman numerals
  );
}
