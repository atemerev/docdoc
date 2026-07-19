// Minimal typings for the pdf.js build served over app://ui/pdfjs/
// (kept external to the esbuild bundle; loaded at runtime).

declare module "*/pdf.mjs" {
  export interface PdfPageViewport { width: number; height: number }
  export interface PdfPage {
    getViewport(opts: { scale: number }): PdfPageViewport;
    render(opts: {
      canvasContext: CanvasRenderingContext2D;
      viewport: PdfPageViewport;
      transform: number[];
    }): { promise: Promise<void> };
  }
  export interface PdfDocument {
    numPages: number;
    getPage(n: number): Promise<PdfPage>;
  }
  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(opts: { url: string }): {
    promise: Promise<PdfDocument>;
  };
}
