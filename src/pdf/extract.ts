import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import { cleanForSpeech, isPageNumber } from "./clean";

/** One text-layer span: page index (0-based) + index among the page's text items. */
export interface SpanRef {
  page: number;
  item: number;
}

/** A unit of speech — usually one sentence. */
export interface Chunk {
  text: string; // cleaned, ready to speak
  parts: SpanRef[];
  page: number; // page where the chunk starts
}

const MAX_CHUNK = 240; // characters; keeps each synthesis request short and responsive

export function textItems(tc: TextContent): TextItem[] {
  return tc.items.filter((i): i is TextItem => "str" in i);
}

interface Line {
  items: number[];
  text: string;
}

/** Group a page's items into lines using pdf.js end-of-line flags. */
function linesOf(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  let cur: Line = { items: [], text: "" };
  items.forEach((it, i) => {
    cur.items.push(i);
    cur.text += it.str;
    if (it.hasEOL || i === items.length - 1) {
      cur.text = cur.text.replace(/\s+/g, " ").trim();
      lines.push(cur);
      cur = { items: [], text: "" };
    }
  });
  return lines;
}

const fontSize = (it: TextItem) => Math.hypot(it.transform[2], it.transform[3]);
const isRotated = (it: TextItem) => Math.abs(it.transform[1]) > 1e-3 || Math.abs(it.transform[2]) > 1e-3;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const boilerplateKey = (t: string) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/**
 * Decide, for every text item, whether it is real body text or page furniture
 * that shouldn't be read: watermarks, running headers/footers, page numbers,
 * rotated margin text, giant decorative letters, superscript markers.
 */
/** Page box in PDF user space: [x0, y0, x1, y1]. */
export type PageBox = number[];

const MARGIN = 0.09; // top/bottom share of the page treated as header/footer area

function marginBand(it: TextItem, box: PageBox | undefined): "top" | "bottom" | null {
  if (!box) return null;
  const [, y0, , y1] = box;
  const h = y1 - y0;
  const y = it.transform[5];
  if (y > y1 - h * MARGIN) return "top";
  if (y < y0 + h * MARGIN) return "bottom";
  return null;
}

function findSkipped(pages: TextItem[][], pageLines: Line[][], boxes: PageBox[]): Set<number>[] {
  // Lines that repeat on many pages are headers, footers or watermarks.
  const counts = new Map<string, number>();
  for (const lines of pageLines) {
    const seen = new Set<string>();
    for (const l of lines) {
      if (!l.text || l.text.length > 100) continue;
      seen.add(boilerplateKey(l.text));
    }
    seen.forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1));
  }
  const n = pages.length;
  const repeatThreshold = Math.max(3, Math.ceil(n * 0.5));

  // Header/footer items: short text in the top/bottom margin that repeats across pages.
  const marginCounts = new Map<string, number>();
  pages.forEach((items, p) => {
    const seen = new Set<string>();
    for (const it of items) {
      const band = marginBand(it, boxes[p]);
      if (band && it.str.trim() && it.str.length <= 100) seen.add(`${band}|${boilerplateKey(it.str)}`);
    }
    seen.forEach((k) => marginCounts.set(k, (marginCounts.get(k) ?? 0) + 1));
  });
  const marginThreshold = Math.max(2, Math.ceil(n * 0.5));

  return pages.map((items, p) => {
    const skip = new Set<number>();
    const body = median(items.filter((it) => /\p{L}/u.test(it.str)).map(fontSize));

    items.forEach((it, i) => {
      const str = it.str.trim();
      if (!str) return;
      const size = fontSize(it);
      const band = marginBand(it, boxes[p]);
      if (band && (isPageNumber(str) || (n >= 2 && (marginCounts.get(`${band}|${boilerplateKey(it.str)}`) ?? 0) >= marginThreshold))) {
        skip.add(i); // running header / footer / page number
      } else if (isRotated(it)) skip.add(i); // diagonal watermarks, vertical margin text
      else if (body && size > body * 2.5 && str.length <= 3) skip.add(i); // giant letters / logos
      else if (body && size < body * 0.75 && /^[\d\s,.*†‡–-]+$/.test(str)) skip.add(i); // superscripts
    });

    for (const line of pageLines[p]) {
      if (!line.text) continue;
      const repeated = n >= 3 && line.text.length <= 100 && (counts.get(boilerplateKey(line.text)) ?? 0) >= repeatThreshold;
      if (repeated || isPageNumber(line.text)) line.items.forEach((i) => skip.add(i));
    }
    return skip;
  });
}

/**
 * Turn the text of every page into speakable sentence chunks.
 * Sentences may span page breaks. Each chunk remembers which text items
 * (and therefore which text-layer spans) it covers so it can be highlighted.
 */
export function buildChunks(contents: TextContent[], boxes: PageBox[] = []): Chunk[] {
  const pages = contents.map(textItems);
  const pageLines = pages.map(linesOf);
  const skipped = findSkipped(pages, pageLines, boxes);

  // The book's text is collected as pieces and joined once at the end. Never inspect
  // or re-slice the growing string itself: that is quadratic and froze long books.
  const pieces: string[] = [];
  let len = 0; // total length so far
  let lastChar = ""; // last character appended
  const isSpace = (c: string) => c === " " || c === "\n" || c === "\t";
  const append = (piece: string) => {
    if (!piece) return;
    pieces.push(piece);
    len += piece.length;
    lastChar = piece[piece.length - 1];
  };

  // Parallel arrays: character range [starts[k], ends[k]) belongs to refs[k]
  const starts: number[] = [];
  const ends: number[] = [];
  const refs: SpanRef[] = [];

  const pushSpace = () => {
    if (len && !isSpace(lastChar)) append(" ");
  };
  // A line break (U+000A) makes Intl.Segmenter end the sentence there.
  const pushBreak = () => {
    if (!len) return;
    if (isSpace(lastChar)) {
      // Replace the trailing space with the break (same position, so offsets stay valid).
      pieces[pieces.length - 1] = pieces[pieces.length - 1].slice(0, -1);
      len--;
    }
    append("\n");
  };

  pages.forEach((items, page) => {
    const skip = skipped[page];
    const lines = pageLines[page];
    const lineLen = median(lines.filter((l) => l.text).map((l) => l.text.length));

    for (const line of lines) {
      const kept = line.items.filter((i) => !skip.has(i));
      if (!kept.length) continue;

      // The last item with actual text decides whether the line ends in a hyphen.
      let lastText = -1;
      kept.forEach((item, k) => {
        if (items[item].str.trim()) lastText = k;
      });
      let hyphenBreak = false;

      kept.forEach((item, k) => {
        const it = items[item];
        let s = it.str.replace(/\s+/g, " ");
        const last = k === kept.length - 1;
        // Join words hyphenated across a line break: "infor-" + "mation"
        // (the hyphen can also be its own text item after the word)
        const loneHyphen = /^\s*-\s*$/.test(s) && /\p{L}/u.test(lastChar);
        if (k === lastText && (/\p{L}-\s*$/u.test(s) || loneHyphen)) {
          s = s.replace(/-\s*$/, "");
          hyphenBreak = true;
        }
        if (s.trim()) {
          if (/^\s/.test(s) && isSpace(lastChar)) s = s.trimStart();
          starts.push(len);
          append(s);
          ends.push(len);
          refs.push({ page, item });
        } else if (s) {
          pushSpace();
        }
        if (last && !hyphenBreak) {
          // Headings, titles and list labels: short lines with no closing punctuation.
          const isHeading = line.text.length < lineLen * 0.6 && !/[.!?,;:\-–—]["')\]]?$/.test(line.text);
          if (isHeading) pushBreak();
          else pushSpace();
        }
      });
    }
    pushSpace();
  });

  // Dot leaders ("Contents ........ 4") and ellipses, cleaned before sentence splitting.
  // Replacements keep the same length so character offsets still match the spans.
  const text = pieces
    .join("")
    .replace(/(?:[ \t]*\.){3,}[ \t]*\d{1,4}\b/g, (m) => "\n" + " ".repeat(m.length - 1))
    .replace(/(?:[ \t]*\.){3,}/g, (m) => "," + " ".repeat(m.length - 1));

  const chunks: Chunk[] = [];
  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  let k = 0; // cursor into refs (segments are in order)

  for (const { segment, index } of mergeAbbreviations(seg.segment(text))) {
    for (const piece of splitLong(segment, index)) {
      const spoken = cleanForSpeech(piece.text);
      if (!/[\p{L}\p{N}]/u.test(spoken)) continue;
      const end = piece.start + piece.text.length;
      while (k < refs.length && ends[k] <= piece.start) k++;
      const parts: SpanRef[] = [];
      for (let j = k; j < refs.length && starts[j] < end; j++) {
        if (ends[j] > piece.start) parts.push(refs[j]);
      }
      if (!parts.length) continue;
      chunks.push({ text: spoken, parts, page: parts[0].page });
    }
  }
  return chunks;
}

// "Dr. Smith", "e.g. this", "3 p.m. today": the segmenter wrongly ends a sentence there.
const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|Inc|Ltd|Co|Corp|vs|etc|e\.g|i\.e|cf|approx|Fig|Figs|No|Vol|pp|p\.m|a\.m|U\.S|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.\s*$/i;

function* mergeAbbreviations(segments: Iterable<{ segment: string; index: number }>) {
  let pending: { segment: string; index: number } | null = null;
  for (const s of segments) {
    if (pending) {
      const joinable = ABBREV.test(pending.segment) && !/\n\s*$/.test(pending.segment);
      if (joinable) {
        pending = { segment: pending.segment + s.segment, index: pending.index };
        continue;
      }
      yield pending;
    }
    pending = s;
  }
  if (pending) yield pending;
}

/** Split an over-long sentence at commas/semicolons, then at spaces. */
function splitLong(s: string, start: number): { text: string; start: number }[] {
  if (s.length <= MAX_CHUNK) return [{ text: s, start }];
  const out: { text: string; start: number }[] = [];
  let from = 0;
  while (s.length - from > MAX_CHUNK) {
    const window = s.slice(from, from + MAX_CHUNK);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    if (cut < MAX_CHUNK * 0.4) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = MAX_CHUNK - 1;
    out.push({ text: s.slice(from, from + cut + 1), start: start + from });
    from += cut + 1;
  }
  out.push({ text: s.slice(from), start: start + from });
  return out;
}
