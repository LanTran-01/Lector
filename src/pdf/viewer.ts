import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { textItems, type SpanRef } from "./extract";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface LoadedDoc {
  doc: PDFDocumentProxy;
  pages: PDFPageProxy[];
  text: TextContent[];
  items: TextItem[][];
}

/** Open a PDF and pull out the text of every page. */
export async function openPdf(data: ArrayBuffer, onProgress: (fraction: number) => void): Promise<LoadedDoc> {
  const base = new URL("pdfjs/", document.baseURI).href;
  const doc = await getDocument({
    data: new Uint8Array(data),
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  }).promise;
  const pages: PDFPageProxy[] = [];
  const text: TextContent[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push(page);
    text.push(await page.getTextContent());
    onProgress(i / doc.numPages);
  }
  return { doc, pages, text, items: text.map(textItems) };
}

interface PageView {
  el: HTMLDivElement;
  page: PDFPageProxy;
  scale: number;
  viewport: PageViewport;
  canvas: HTMLCanvasElement | null;
  renderTask: RenderTask | null;
  canvasScale: number; // scale the canvas was drawn at
  textLayer: TextLayer | null;
  textDivs: HTMLElement[];
  visible: boolean;
}

const MAX_PAGE_WIDTH = 920;
const SIDE_GUTTER = 16;

/**
 * Lays out every page at fit-width size, then draws canvases and text layers
 * only for pages near the viewport (and frees canvases far away).
 */
export class Viewer {
  private views: PageView[] = [];
  private loaded: LoadedDoc | null = null;
  private observer: IntersectionObserver;
  private resizeObserver: ResizeObserver;
  private resizeTimer = 0;
  private lastWidth = 0;
  onPageText: (pageIndex: number) => void = () => {};

  constructor(
    private scroller: HTMLElement,
    private host: HTMLElement,
  ) {
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: scroller,
      rootMargin: "120% 0px",
    });
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.relayout(), 120);
    });
    this.resizeObserver.observe(scroller);
  }

  get pageCount(): number {
    return this.views.length;
  }

  setDoc(loaded: LoadedDoc): void {
    this.clear();
    this.loaded = loaded;
    this.lastWidth = this.scroller.clientWidth;
    const frag = document.createDocumentFragment();
    loaded.pages.forEach((page, i) => {
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.index = String(i);
      const num = document.createElement("span");
      num.className = "page-num";
      num.textContent = `${i + 1} / ${loaded.pages.length}`;
      el.append(num);
      const scale = this.fitScale(page);
      const view: PageView = {
        el,
        page,
        scale,
        viewport: page.getViewport({ scale }),
        canvas: null,
        renderTask: null,
        canvasScale: 0,
        textLayer: null,
        textDivs: [],
        visible: false,
      };
      this.size(view);
      this.views.push(view);
      frag.append(el);
    });
    this.host.append(frag);
    this.views.forEach((v) => this.observer.observe(v.el));
    this.scroller.scrollTop = 0;
  }

  clear(): void {
    this.observer.disconnect();
    for (const v of this.views) {
      v.renderTask?.cancel();
      v.textLayer?.cancel();
    }
    this.views = [];
    this.host.replaceChildren();
    if (this.loaded) {
      void this.loaded.doc.loadingTask.destroy();
      this.loaded = null;
    }
  }

  /** The text-layer span for an item, if that page's text layer exists. */
  getSpan(ref: SpanRef): HTMLElement | null {
    return this.views[ref.page]?.textDivs[ref.item] ?? null;
  }

  /** Vertical position (scroll coordinates) of the top of a text item. */
  yOf(ref: SpanRef): number {
    const v = this.views[ref.page];
    const item = this.loaded?.items[ref.page]?.[ref.item];
    if (!v) return 0;
    if (!item) return v.el.offsetTop;
    const [, y] = v.viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const fontHeight = Math.hypot(item.transform[2], item.transform[3]) * v.scale;
    return v.el.offsetTop + Math.max(0, y - fontHeight);
  }

  /** Page index whose area covers the reading line (40% down the viewport). */
  pageAtScroll(): number {
    const line = this.scroller.scrollTop + this.scroller.clientHeight * 0.4;
    let lo = 0;
    let hi = this.views.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.views[mid].el.offsetTop <= line) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  private fitScale(page: PDFPageProxy): number {
    const base = page.getViewport({ scale: 1 });
    const width = Math.min(MAX_PAGE_WIDTH, this.scroller.clientWidth - SIDE_GUTTER * 2);
    return Math.max(0.25, width / base.width);
  }

  private size(v: PageView): void {
    v.el.style.width = `${Math.floor(v.viewport.width)}px`;
    v.el.style.height = `${Math.floor(v.viewport.height)}px`;
    v.el.style.setProperty("--total-scale-factor", String(v.scale));
  }

  private relayout(): void {
    if (!this.views.length) return;
    const width = this.scroller.clientWidth;
    if (width === this.lastWidth) return;
    // Keep the same spot in the document after re-sizing.
    const anchorPage = this.pageAtScroll();
    const anchorEl = this.views[anchorPage].el;
    const within = (this.scroller.scrollTop - anchorEl.offsetTop) / anchorEl.offsetHeight;
    this.lastWidth = width;
    for (const v of this.views) {
      v.scale = this.fitScale(v.page);
      v.viewport = v.page.getViewport({ scale: v.scale });
      this.size(v);
      v.textLayer?.update({ viewport: v.viewport });
      if (v.visible) void this.drawCanvas(v);
    }
    this.scroller.scrollTop = anchorEl.offsetTop + within * anchorEl.offsetHeight;
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const v = this.views[Number((e.target as HTMLElement).dataset.index)];
      if (!v) continue;
      v.visible = e.isIntersecting;
      if (v.visible) {
        void this.drawCanvas(v);
        void this.drawText(v);
      } else {
        this.freeCanvas(v);
      }
    }
  }

  private async drawCanvas(v: PageView): Promise<void> {
    if (v.canvas && v.canvasScale === v.scale && !v.renderTask) return;
    v.renderTask?.cancel();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(v.viewport.width * dpr);
    canvas.height = Math.floor(v.viewport.height * dpr);
    const task = v.page.render({
      canvas,
      viewport: v.viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    v.renderTask = task;
    try {
      await task.promise;
    } catch {
      return; // cancelled
    } finally {
      if (v.renderTask === task) v.renderTask = null;
    }
    if (!v.visible) return;
    v.canvas?.remove();
    v.canvas = canvas;
    v.canvasScale = v.scale;
    v.el.prepend(canvas);
  }

  private freeCanvas(v: PageView): void {
    v.renderTask?.cancel();
    v.renderTask = null;
    if (v.canvas) {
      v.canvas.width = v.canvas.height = 0; // release GPU memory promptly
      v.canvas.remove();
      v.canvas = null;
    }
  }

  private async drawText(v: PageView): Promise<void> {
    if (v.textLayer || !this.loaded) return;
    const i = this.views.indexOf(v);
    const container = document.createElement("div");
    container.className = "textLayer";
    const layer = new TextLayer({
      textContentSource: this.loaded.text[i],
      container,
      viewport: v.viewport,
    });
    v.textLayer = layer;
    v.el.append(container);
    try {
      await layer.render();
    } catch {
      return;
    }
    v.textDivs = layer.textDivs;
    v.textDivs.forEach((d, k) => (d.dataset.i = String(k)));
    this.onPageText(i);
  }
}
