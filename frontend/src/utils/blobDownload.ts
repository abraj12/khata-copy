/**
 * Triggers a browser download for a Blob and defers URL.revokeObjectURL() so desktop
 * browsers and Android WebView/TWA DownloadManager finishes reading the blob stream
 * before the object URL is invalidated.
 */
export function downloadBlobSafely(
  blob: Blob,
  filename: string,
  revokeDelayMs = 60_000
): () => void {
  const urlApi = typeof window !== 'undefined' && window.URL ? window.URL : URL;
  const blobUrl = urlApi.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';

  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    document.body.removeChild(link);
  }

  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    urlApi.revokeObjectURL(blobUrl);
  };

  const timer = setTimeout(revoke, Math.max(1000, revokeDelayMs));
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }

  return () => {
    clearTimeout(timer);
    revoke();
  };
}
