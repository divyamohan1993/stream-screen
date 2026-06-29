/**
 * OCR a screen frame buffer into text using `tesseract.js`.
 *
 * `tesseract.js` is a pure-JS (WASM) OCR engine and is declared as an OPTIONAL
 * dependency: the AI server still installs, builds, and runs its non-OCR tools
 * without it. We therefore load it lazily via dynamic `import()` and surface a
 * clear, actionable error if it is missing rather than crashing at module load.
 *
 * There are no usage limits, watermarks, or time caps here — OCR is unbounded
 * and free, like the rest of StreamScreen.
 */

/** Minimal surface of `tesseract.js` that {@link ocrImage} relies on. */
interface TesseractModule {
  recognize: (
    image: Buffer | Uint8Array | string,
    langs?: string,
    options?: Record<string, unknown>,
  ) => Promise<{ data: { text: string } }>;
}

let cached: TesseractModule | null = null;

/** Error thrown when the optional OCR engine is not installed. */
export class OcrUnavailableError extends Error {
  constructor() {
    super(
      'OCR is unavailable: the optional dependency "tesseract.js" is not installed. ' +
        'Install it with `npm install tesseract.js` to enable the ocr_screen tool.',
    );
    this.name = 'OcrUnavailableError';
  }
}

/**
 * Resolve the `tesseract.js` module, loading it once and caching the result.
 * Throws {@link OcrUnavailableError} if the optional package is not present.
 */
async function resolveTesseract(): Promise<TesseractModule> {
  if (cached) return cached;
  let mod: unknown;
  try {
    mod = await import('tesseract.js');
  } catch {
    throw new OcrUnavailableError();
  }
  const m = mod as { default?: TesseractModule; recognize?: TesseractModule['recognize'] };
  const recognize = m.recognize ?? m.default?.recognize;
  if (typeof recognize !== 'function') {
    throw new OcrUnavailableError();
  }
  cached = { recognize };
  return cached;
}

/** Whether the optional OCR engine is installed in this environment. */
export async function isOcrAvailable(): Promise<boolean> {
  try {
    await resolveTesseract();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run OCR over an encoded image buffer (e.g. a PNG screenshot) and return the
 * recognized text, trimmed of surrounding whitespace.
 *
 * @param image  Encoded image bytes (PNG/JPEG/etc.).
 * @param lang   Tesseract language string (default `'eng'`).
 */
export async function ocrImage(image: Buffer | Uint8Array, lang = 'eng'): Promise<string> {
  const tesseract = await resolveTesseract();
  const buf = image instanceof Buffer ? image : Buffer.from(image);
  const result = await tesseract.recognize(buf, lang);
  return result.data.text.trim();
}
