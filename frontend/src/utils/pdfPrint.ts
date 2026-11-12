export interface PdfPrintResult {
  method: 'iframe' | 'window' | 'download';
  notice: string | null;
}

export interface PdfPrintHandle {
  cleanup: () => void;
  promise: Promise<PdfPrintResult>;
}

export interface PdfPrintOptions {
  pdfBlob: Blob;
  onFallbackDownload: () => void;
  iframeLoadTimeoutMs?: number;
  maxObjectUrlLifetimeMs?: number;
}

const DEFAULT_IFRAME_LOAD_TIMEOUT_MS = 3500;
const DEFAULT_MAX_OBJECT_URL_LIFETIME_MS = 120_000;

function detectMobileOrLimitedWebView(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|wv\b/i.test(navigator.userAgent || '');
}

/**
 * Prints a canonical PDF Blob via an Object URL without rasterizing pages to PNG canvases.
 * Uses a hidden iframe on desktop browsers (falling back to window.open or download on failure)
 * and tracks lifecycle listeners + timers so every Blob URL is deterministically revoked.
 */
export function printCanonicalPdfBlob(options: PdfPrintOptions): PdfPrintHandle {
  const {
    pdfBlob,
    onFallbackDownload,
    iframeLoadTimeoutMs = DEFAULT_IFRAME_LOAD_TIMEOUT_MS,
    maxObjectUrlLifetimeMs = DEFAULT_MAX_OBJECT_URL_LIFETIME_MS,
  } = options;

  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    onFallbackDownload();
    return {
      cleanup: () => {},
      promise: Promise.resolve({
        method: 'download',
        notice: 'Browser does not support inline PDF printing — downloaded canonical PDF instead.',
      }),
    };
  }

  const objectUrl = URL.createObjectURL(pdfBlob);
  let cleaned = false;
  let settled = false;
  let fallbackInvoked = false;
  let iframe: HTMLIFrameElement | null = null;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  let revokeTimer: ReturnType<typeof setTimeout> | null = null;
  const removers: Array<() => void> = [];
  let resolvePromise!: (result: PdfPrintResult) => void;

  const promise = new Promise<PdfPrintResult>((resolve) => {
    resolvePromise = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
  });

  const detachIframe = () => {
    if (loadTimer !== null) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }
    const targetIframe = iframe;
    iframe = null;
    if (targetIframe) {
      while (removers.length > 0) {
        const remove = removers.pop();
        try {
          remove?.();
        } catch {
          // Ignore listener removal errors
        }
      }
      try {
        targetIframe.parentNode?.removeChild(targetIframe);
      } catch {
        // Ignore DOM removal errors
      }
      try {
        targetIframe.removeAttribute('src');
      } catch {
        // Ignore teardown errors on detached frames
      }
    }
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;

    if (loadTimer !== null) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }
    if (revokeTimer !== null) {
      clearTimeout(revokeTimer);
      revokeTimer = null;
    }

    while (removers.length > 0) {
      const remove = removers.pop();
      try {
        remove?.();
      } catch {
        // Ignore listener removal errors
      }
    }

    detachIframe();

    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Ignore revoke errors on closed realms
    }

    resolvePromise({ method: 'iframe', notice: null });
  };

  const addListener = (
    target: EventTarget | null | undefined,
    event: string,
    handler: EventListenerOrEventListenerObject,
    once = false
  ) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(event, handler, once ? { once: true } : undefined);
    removers.push(() => {
      try {
        target.removeEventListener(event, handler);
      } catch {
        // Ignore cleanup listener errors
      }
    });
  };

  const scheduleDeferredRevoke = (targetWindow?: Window | null) => {
    if (cleaned) return;
    addListener(targetWindow, 'afterprint', cleanup, true);
    addListener(targetWindow, 'pagehide', cleanup, true);
    if (typeof window !== 'undefined') {
      addListener(window, 'afterprint', cleanup, true);
    }
    if (revokeTimer === null) {
      revokeTimer = setTimeout(cleanup, maxObjectUrlLifetimeMs);
    }
  };

  const fallbackToWindowOrDownload = () => {
    if (cleaned || settled || fallbackInvoked) return;
    fallbackInvoked = true;
    detachIframe();

    // Do NOT pass noopener,noreferrer in features — Chromium/Android returns null!
    const printWindow =
      typeof window !== 'undefined' && typeof window.open === 'function'
        ? window.open(objectUrl, '_blank')
        : null;

    if (!printWindow) {
      onFallbackDownload();
      resolvePromise({
        method: 'download',
        notice: 'Pop-up blocked by browser — downloaded canonical PDF instead.',
      });
      cleanup();
      return;
    }

    try {
      printWindow.opener = null;
    } catch {
      // Ignore read-only opener implementations
    }

    let windowPrintTriggered = false;
    const triggerWindowPrint = () => {
      if (cleaned || windowPrintTriggered) return;
      windowPrintTriggered = true;
      try {
        printWindow.focus?.();
        printWindow.print?.();
      } catch {
        // User can print directly from the opened native PDF viewer tab
      }
    };

    scheduleDeferredRevoke(printWindow);
    addListener(printWindow, 'load', triggerWindowPrint, true);

    try {
      if (printWindow.document?.readyState === 'complete') {
        queueMicrotask(triggerWindowPrint);
      }
    } catch {
      // Native PDF viewer window may restrict document inspection; load/user print handles it
    }

    resolvePromise({ method: 'window', notice: null });
  };

  const canUseIframe =
    !detectMobileOrLimitedWebView() &&
    typeof document !== 'undefined' &&
    document.body &&
    typeof document.createElement === 'function';

  if (!canUseIframe) {
    fallbackToWindowOrDownload();
    return { cleanup, promise };
  }

  try {
    iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.title = 'Canonical PDF Print Frame';

    const onIframeLoad = () => {
      if (cleaned || settled) return;
      if (loadTimer !== null) {
        clearTimeout(loadTimer);
        loadTimer = null;
      }

      try {
        const frameWin = iframe?.contentWindow;
        if (!frameWin || typeof frameWin.print !== 'function') {
          fallbackToWindowOrDownload();
          return;
        }
        scheduleDeferredRevoke(frameWin);
        frameWin.focus?.();
        frameWin.print();
        resolvePromise({ method: 'iframe', notice: null });
      } catch {
        fallbackToWindowOrDownload();
      }
    };

    const onIframeError = () => {
      if (cleaned || settled) return;
      fallbackToWindowOrDownload();
    };

    addListener(iframe, 'load', onIframeLoad, true);
    addListener(iframe, 'error', onIframeError, true);

    loadTimer = setTimeout(() => {
      if (!cleaned && !settled) {
        fallbackToWindowOrDownload();
      }
    }, iframeLoadTimeoutMs);

    iframe.src = objectUrl;
    document.body.appendChild(iframe);
  } catch {
    fallbackToWindowOrDownload();
  }

  return { cleanup, promise };
}
