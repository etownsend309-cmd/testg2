/**
 * PDF.js driver for the proof of concept.
 *
 * Runs entirely on the client. The file never leaves the browser: it is read
 * into memory, parsed by PDF.js, and discarded when the page is reset.
 *
 * One parse feeds both reconstruction strategies, so the comparison is fair and
 * the document is only decoded once.
 */

// The `legacy` build is the one PDF.js supports in Node, and it works in the
// browser too. Using it in both places means the benchmark measures exactly the
// same code path the app runs, with no second bundle to keep in sync.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

import { buildContentOrderText } from "./contentOrder";
import { reconstructCoordinateOrder } from "./coordinateOrder";
import {
  buildPages,
  dedupe,
  evaluateExtraction,
  isUsable,
  LOW_TEXT_THRESHOLD_PER_PAGE,
} from "./evaluateExtraction";
import type {
  ExtractionRun,
  ExtractionStatus,
  FallbackReason,
  StrategyId,
  StrategyResult,
  TextFragment,
} from "./types";

export const PDFJS_VERSION: string = pdfjsLib.version ?? "unknown";

const STRATEGY_META: Record<StrategyId, { name: string; description: string }> = {
  "content-order": {
    name: "Strategy A - content-stream order",
    description:
      "Concatenates PDF.js text items in the order the PDF's content stream lists them, breaking lines on PDF.js' end-of-line marker.",
  },
  "coordinate-order": {
    name: "Strategy B - coordinate reconstruction",
    description:
      "Ignores stream order and rebuilds reading order from each item's position: groups items into lines, detects a column gutter, then reads top-to-bottom and left-to-right.",
  },
};

let workerConfigured = false;

/**
 * PDF.js needs a worker in the browser so that parsing a large document does
 * not freeze the page. In Node (benchmark, unit tests) PDF.js falls back to
 * running on the main thread, which is what we want there.
 *
 * The worker is imported with Vite's `?url` suffix rather than `new URL(...,
 * import.meta.url)`: `new URL` would treat the bare package specifier as a
 * relative path and ask the dev server for a file that does not exist. The
 * import is dynamic and guarded so Node never evaluates it.
 */
async function configureWorker(): Promise<void> {
  if (workerConfigured || typeof window === "undefined") return;
  workerConfigured = true;
  try {
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url");
    pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default;
  } catch (error) {
    // No bundler to resolve the `?url` suffix, which happens in the jsdom
    // component tests. PDF.js then parses on the main thread: slower, but
    // correct, so extraction still works rather than failing outright.
    logDeveloperDetail("no bundled worker; parsing on the main thread", error);
  }
}

const IMAGE_OPS = new Set<number>([
  pdfjsLib.OPS.paintImageXObject,
  pdfjsLib.OPS.paintInlineImageXObject,
  pdfjsLib.OPS.paintImageMaskXObject,
]);

/** Reduce a PDF.js text item to the geometry the strategies need. */
export function toFragment(item: TextItem): TextFragment {
  // transform is [scaleX, skewX, skewY, scaleY, translateX, translateY].
  const [, , , scaleY, x, y] = item.transform as number[];
  return {
    text: item.str,
    x,
    y,
    width: item.width ?? 0,
    height: item.height || Math.abs(scaleY) || 0,
    hasEOL: Boolean(item.hasEOL),
  };
}

export interface ExtractOptions {
  fileName?: string;
  fileSizeBytes?: number;
  /** Wall-clock budget for the whole document. */
  timeoutMs?: number;
  lowTextThreshold?: number;
}

/**
 * Parse a PDF and reconstruct its text with both strategies.
 *
 * Never throws: a failure becomes a `failed` run with a short, safe message.
 * Stack traces stay in the developer console.
 */
export async function extractPdf(
  data: ArrayBuffer | Uint8Array,
  options: ExtractOptions = {},
): Promise<ExtractionRun> {
  const {
    fileName = "document.pdf",
    fileSizeBytes = data.byteLength,
    timeoutMs = 30_000,
    lowTextThreshold = LOW_TEXT_THRESHOLD_PER_PAGE,
  } = options;

  await configureWorker();

  const startedAt = performance.now();
  const documentWarnings: string[] = [];
  const seedReasons: FallbackReason[] = [];
  const pageFailures: number[] = [];

  const contentPages: string[] = [];
  const coordinatePages: string[] = [];
  let contentMs = 0;
  let coordinateMs = 0;

  let hardError: string | null = null;
  let pageCount = 0;
  let pagesWithImages = 0;
  let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

  try {
    // PDF.js takes ownership of the buffer it is handed, so pass a private copy.
    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));

    loadingTask = pdfjsLib.getDocument({
      data: bytes,
      // This POC opens files the team did not author, so do not let a document
      // pull system fonts, and keep going instead of rejecting on soft errors.
      useSystemFonts: false,
      stopAtErrors: false,
    });

    const doc = await withTimeout(loadingTask.promise, timeoutMs, "Parsing the document");
    pageCount = doc.numPages;

    if (pageCount === 0) {
      documentWarnings.push("PDF.js opened the file but reported zero pages.");
    }

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      try {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        const fragments = (content.items as TextItem[])
          .filter((item) => "str" in item)
          .map(toFragment);

        const contentStart = performance.now();
        contentPages.push(buildContentOrderText(fragments));
        contentMs += performance.now() - contentStart;

        const coordinateStart = performance.now();
        coordinatePages.push(reconstructCoordinateOrder(fragments));
        coordinateMs += performance.now() - coordinateStart;

        const operators = await page.getOperatorList();
        if (containsImage(operators)) pagesWithImages += 1;

        page.cleanup();
      } catch (error) {
        contentPages.push("");
        coordinatePages.push("");
        pageFailures.push(pageNumber);
        logDeveloperDetail(`page ${pageNumber} failed`, error);
      }
    }
  } catch (error) {
    hardError = describeError(error);
    seedReasons.push(classifyError(error));
    logDeveloperDetail("document failed to open", error);
  } finally {
    // Releases the worker and the document's copy of the file bytes.
    try {
      await loadingTask?.destroy();
    } catch {
      /* nothing useful to do while tearing down */
    }
  }

  const noTextAnywhere =
    contentPages.length > 0 && contentPages.every((text) => text.trim().length === 0);
  const looksScanned = noTextAnywhere && pagesWithImages > 0;

  if (looksScanned) {
    seedReasons.push("scanned-no-text-layer");
    documentWarnings.push(
      `${pagesWithImages} of ${pageCount} page(s) carry an image but no text layer. ` +
        "PDF.js reads existing text; it does not perform OCR, so a scanned document yields nothing.",
    );
  } else if (noTextAnywhere && pageCount > 0) {
    documentWarnings.push(
      "No text layer and no page images were found. The document may be corrupt, empty, or use an unsupported construction.",
    );
  }

  const strategies: StrategyResult[] = [
    buildStrategy("content-order", contentPages, contentMs, {
      hardError,
      seedReasons,
      pageFailures,
      lowTextThreshold,
    }),
    buildStrategy("coordinate-order", coordinatePages, coordinateMs, {
      hardError,
      seedReasons,
      pageFailures,
      lowTextThreshold,
    }),
  ];

  const usable = strategies.filter(isUsable);
  const status: ExtractionStatus = hardError || usable.length === 0
    ? "failed"
    : strategies.some((s) => s.status === "warning")
      ? "warning"
      : "success";

  const fallbackReasons = dedupe([
    ...seedReasons,
    ...(usable.length === 0 ? strategies.flatMap((s) => s.fallbackReasons) : []),
  ]);

  return {
    fileName,
    fileSizeBytes,
    pdfjsVersion: PDFJS_VERSION,
    totalElapsedMs: round2(performance.now() - startedAt),
    pageCount,
    status,
    strategies,
    warnings: documentWarnings,
    error: hardError,
    fallbackRecommended: usable.length === 0 || fallbackReasons.length > 0,
    fallbackReasons,
    looksScanned,
    testedAt: new Date().toISOString(),
  };
}

function buildStrategy(
  strategy: StrategyId,
  perPageText: string[],
  elapsedMs: number,
  context: {
    hardError: string | null;
    seedReasons: FallbackReason[];
    pageFailures: number[];
    lowTextThreshold: number;
  },
): StrategyResult {
  const pages = buildPages(perPageText);
  const evaluation = evaluateExtraction({
    pages,
    hardError: context.hardError,
    seedReasons: context.seedReasons,
    pageFailures: context.pageFailures,
    lowTextThreshold: context.lowTextThreshold,
  });

  return {
    strategy,
    strategyName: STRATEGY_META[strategy].name,
    strategyDescription: STRATEGY_META[strategy].description,
    status: evaluation.status,
    elapsedMs: round2(elapsedMs),
    pageCount: pages.length,
    characterCount: evaluation.characterCount,
    printableCharacterCount: evaluation.printableCharacterCount,
    charactersPerPage: evaluation.charactersPerPage,
    printableCharactersPerPage: evaluation.printableCharactersPerPage,
    emptyPages: evaluation.emptyPages,
    pagesWithText: evaluation.pagesWithText,
    pages,
    text: pages.map((page) => page.text).join("\n\n"),
    warnings: evaluation.warnings,
    fallbackRecommended: evaluation.fallbackRecommended,
    fallbackReasons: evaluation.fallbackReasons,
  };
}

function containsImage(operatorList: { fnArray: ArrayLike<number> }): boolean {
  const { fnArray } = operatorList;
  for (let index = 0; index < fnArray.length; index += 1) {
    if (IMAGE_OPS.has(fnArray[index])) return true;
  }
  return false;
}

/** Map a PDF.js exception to a reason the fallback rule understands. */
export function classifyError(error: unknown): FallbackReason {
  const name = (error as { name?: string })?.name;
  if (name === "PasswordException") return "password-protected";
  if (name === "TimeoutError") return "extraction-timeout";
  return "document-unreadable";
}

/**
 * Turn an exception into one short sentence safe to show a user.
 * Deliberately drops the stack and any internal detail.
 */
export function describeError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  switch (name) {
    case "PasswordException":
      return "This PDF is password protected. The proof of concept does not accept passwords, so its text cannot be read.";
    case "InvalidPDFException":
      return "PDF.js could not parse this file. It is not a valid PDF, or its structure is damaged.";
    case "MissingPDFException":
      return "The file could not be read.";
    case "TimeoutError":
      return "PDF.js did not finish within the time budget for this document.";
    case "UnexpectedResponseException":
      return "The file could not be loaded.";
    default: {
      const message = error instanceof Error ? error.message : String(error);
      const firstLine = (message.split("\n")[0] ?? "").trim();
      if (!firstLine) return "PDF.js failed with an unknown error.";
      const trimmed = firstLine.length > 200 ? `${firstLine.slice(0, 200)}...` : firstLine;
      return `PDF.js failed: ${trimmed}`;
    }
  }
}

/** Developer detail goes to the console only, never to the interface. */
function logDeveloperDetail(context: string, error: unknown): void {
  if (typeof console !== "undefined") {
    console.debug(`[pdf.js] ${context}`, error);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${what} exceeded ${ms} ms.`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
