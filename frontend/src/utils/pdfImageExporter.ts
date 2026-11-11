import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { downloadBlobSafely } from './blobDownload';

export interface ExportedPdfPageImage {
  pageNumber: number;
  totalPages: number;
  fileName: string;
  file: File;
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface PdfImageExportProgress {
  currentPage: number;
  totalPages: number;
}

export interface ExportPdfToWebpOptions {
  blob: Blob;
  baseFileName: string;
  quality?: number;
  maxWidth?: number;
  scale?: number;
  signal?: AbortSignal;
  onProgress?: (progress: PdfImageExportProgress) => void;
}

let workerConfigured = false;

export async function loadPdfJs() {
  const pdfjsLib = await import('pdfjs-dist');
  if (!workerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    workerConfigured = true;
  }
  return pdfjsLib;
}

export function sanitizePdfExportBaseName(rawName: string): string {
  const withoutExt = rawName.replace(/\.pdf$/i, '').trim();
  const sanitized = withoutExt
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'Document';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('PDF image export aborted', 'AbortError');
  }
}

/**
 * Encodes an HTMLCanvasElement as a crisp compressed WebP Blob (downscaling cleanly when wider than maxWidth),
 * freeing any intermediate scaling canvas immediately afterward.
 */
export async function canvasToWebP(
  canvas: HTMLCanvasElement,
  quality: number = 0.85,
  maxWidth: number = 1400
): Promise<Blob> {
  let targetCanvas = canvas;
  let tempCanvas: HTMLCanvasElement | null = null;

  if (canvas.width > maxWidth && canvas.width > 0) {
    const ratio = maxWidth / canvas.width;
    const targetHeight = Math.max(1, Math.round(canvas.height * ratio));
    tempCanvas = document.createElement('canvas');
    tempCanvas.width = maxWidth;
    tempCanvas.height = targetHeight;
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) {
      tempCtx.imageSmoothingEnabled = true;
      tempCtx.imageSmoothingQuality = 'high';
      tempCtx.drawImage(canvas, 0, 0, maxWidth, targetHeight);
      targetCanvas = tempCanvas;
    }
  }

  try {
    const webpBlob = await new Promise<Blob | null>((resolve) => {
      targetCanvas.toBlob((blob) => resolve(blob), 'image/webp', quality);
    });
    if (webpBlob && webpBlob.size > 0) {
      return webpBlob;
    }

    const fallbackBlob = await new Promise<Blob | null>((resolve) => {
      targetCanvas.toBlob((blob) => resolve(blob), 'image/png', 0.92);
    });
    if (fallbackBlob && fallbackBlob.size > 0) {
      return fallbackBlob;
    }

    throw new Error('Browser failed to encode canvas to WebP/PNG image.');
  } finally {
    if (tempCanvas) {
      const ctx = tempCanvas.getContext('2d');
      ctx?.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
      tempCanvas.width = 0;
      tempCanvas.height = 0;
    }
  }
}

/**
 * Converts every page of a PDF Blob sequentially into crisp compressed WebP Files
 * (e.g. Invoice_INV-001_page_01.webp), releasing canvas memory and PDF workers cleanly.
 */
export async function exportPdfBlobToWebpPages(
  options: ExportPdfToWebpOptions
): Promise<ExportedPdfPageImage[]> {
  const {
    blob,
    baseFileName,
    quality = 0.85,
    maxWidth = 1400,
    scale = 2.0,
    signal,
    onProgress,
  } = options;

  throwIfAborted(signal);
  const safeBase = sanitizePdfExportBaseName(baseFileName);
  const pdfjsLib = await loadPdfJs();
  throwIfAborted(signal);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  throwIfAborted(signal);

  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    verbosity: 0,
  });

  const handleAbort = () => {
    loadingTask.destroy().catch(() => {});
  };
  signal?.addEventListener('abort', handleAbort, { once: true });

  const exportedPages: ExportedPdfPageImage[] = [];
  let pdfDoc: Awaited<typeof loadingTask.promise> | null = null;

  try {
    pdfDoc = await loadingTask.promise;
    const totalPages = pdfDoc.numPages;

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      throwIfAborted(signal);
      onProgress?.({ currentPage: pageNumber, totalPages });

      const page = await pdfDoc.getPage(pageNumber);
      const canvas = document.createElement('canvas');
      try {
        const unscaledViewport = page.getViewport({ scale: 1 });
        const effectiveScale = Math.max(
          1,
          Math.min(scale, maxWidth / Math.max(1, unscaledViewport.width))
        );
        const viewport = page.getViewport({ scale: effectiveScale });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) {
          throw new Error('Could not initialize 2D canvas context for PDF image export.');
        }
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
        });
        await renderTask.promise;
        throwIfAborted(signal);

        const encodedBlob = await canvasToWebP(canvas, quality, maxWidth);
        throwIfAborted(signal);

        const paddedPage = String(pageNumber).padStart(2, '0');
        const ext = encodedBlob.type === 'image/png' ? 'png' : 'webp';
        const fileName = `${safeBase}_page_${paddedPage}.${ext}`;
        const file = new File([encodedBlob], fileName, {
          type: encodedBlob.type || 'image/webp',
          lastModified: Date.now(),
        });
        const previewUrl = URL.createObjectURL(encodedBlob);

        exportedPages.push({
          pageNumber,
          totalPages,
          fileName,
          file,
          blob: encodedBlob,
          previewUrl,
          width: canvas.width,
          height: canvas.height,
          sizeBytes: encodedBlob.size,
        });
      } finally {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    }

    return exportedPages;
  } catch (err) {
    cleanupExportedPageImages(exportedPages);
    throw err;
  } finally {
    signal?.removeEventListener('abort', handleAbort);
    if (pdfDoc) {
      await pdfDoc.cleanup().catch(() => {});
    }
    await loadingTask.destroy().catch(() => {});
  }
}

export function cleanupExportedPageImages(pages: ExportedPdfPageImage[]): void {
  for (const page of pages) {
    if (page.previewUrl) {
      URL.revokeObjectURL(page.previewUrl);
    }
  }
}

export function downloadExportedPageImages(pages: ExportedPdfPageImage[]): void {
  for (const page of pages) {
    downloadBlobSafely(page.blob, page.fileName);
  }
}

export function canUseNativeFileShare(pages: ExportedPdfPageImage[]): boolean {
  if (typeof navigator === 'undefined' || pages.length === 0) return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return false;
  }
  try {
    return navigator.canShare({ files: pages.map((p) => p.file) });
  } catch {
    return false;
  }
}

export async function shareOrDownloadPdfImages(
  pages: ExportedPdfPageImage[],
  title: string
): Promise<{ method: 'share' | 'download'; cancelled?: boolean }> {
  if (pages.length === 0) {
    return { method: 'download' };
  }

  if (canUseNativeFileShare(pages)) {
    try {
      await navigator.share({
        title,
        files: pages.map((p) => p.file),
      });
      return { method: 'share' };
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') {
        return { method: 'share', cancelled: true };
      }
    }
  }

  downloadExportedPageImages(pages);
  return { method: 'download' };
}
