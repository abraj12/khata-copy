/**
 * Client-Side Image Compression Utility
 * 
 * Automatically compresses and resizes high-resolution smartphone camera photos
 * before uploading them to the backend / Cloudflare R2.
 * 
 * Benefits:
 * - 10MB camera photo -> ~150KB - 250KB (95%+ reduction)
 * - Upload completes in milliseconds instead of seconds on mobile 4G/3G networks
 * - Guarantees the compressed image strictly fits backend limits (5MB products / 10MB bills)
 * - Zero external dependencies; uses native HTML5 Canvas
 */

export interface CompressImageOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number; // 0.1 to 1.0 (default 0.8)
  maxSizeBytes?: number; // Maximum allowed upload limit in bytes (e.g. 4.5MB)
  targetType?: 'image/jpeg' | 'image/webp';
}

export async function compressImageFile(
  file: File,
  options: CompressImageOptions = {}
): Promise<File> {
  const {
    maxWidth = 1200,
    maxHeight = 1200,
    quality = 0.8,
    maxSizeBytes,
    targetType = 'image/jpeg',
  } = options;

  // In non-browser environments or if Canvas is unavailable, return original file if within limits
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof HTMLCanvasElement === 'undefined'
  ) {
    if (maxSizeBytes && file.size > maxSizeBytes) {
      const limitMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
      throw new Error(`Image size exceeds the ${limitMb} MB limit.`);
    }
    return file;
  }

  // Only compress raster images (jpeg, png, webp)
  const supportedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!supportedTypes.includes(file.type)) {
    if (maxSizeBytes && file.size > maxSizeBytes) {
      const limitMb = (maxSizeBytes / (1024 * 1024)).toFixed(1);
      throw new Error(`File size exceeds the ${limitMb} MB limit.`);
    }
    return file;
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      if (maxSizeBytes && file.size > maxSizeBytes) {
        reject(new Error(`Image size exceeds the ${(maxSizeBytes / (1024 * 1024)).toFixed(1)} MB limit.`));
      } else {
        resolve(file);
      }
    };

    reader.onload = () => {
      const img = new Image();
      img.onerror = () => {
        if (maxSizeBytes && file.size > maxSizeBytes) {
          reject(new Error(`Image size exceeds the ${(maxSizeBytes / (1024 * 1024)).toFixed(1)} MB limit.`));
        } else {
          resolve(file);
        }
      };

      img.onload = () => {
        try {
          let currentWidth = img.width;
          let currentHeight = img.height;

          // Scale down dimensions preserving aspect ratio
          if (currentWidth > maxWidth || currentHeight > maxHeight) {
            const ratio = Math.min(maxWidth / currentWidth, maxHeight / currentHeight);
            currentWidth = Math.round(currentWidth * ratio);
            currentHeight = Math.round(currentHeight * ratio);
          } else if (file.size < 200 * 1024 && (!maxSizeBytes || file.size <= maxSizeBytes)) {
            // Already small and within bounds: keep original
            resolve(file);
            return;
          }

          let currentQuality = quality;

          const attemptCompression = (w: number, h: number, q: number, attemptCount: number) => {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
              if (maxSizeBytes && file.size > maxSizeBytes) {
                reject(new Error(`Unable to compress image to fit within ${(maxSizeBytes / (1024 * 1024)).toFixed(1)} MB.`));
              } else {
                resolve(file);
              }
              return;
            }

            // Fill white background for transparent PNGs converted to JPEG
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);

            canvas.toBlob(
              (blob) => {
                if (!blob) {
                  if (maxSizeBytes && file.size > maxSizeBytes) {
                    reject(new Error(`Unable to compress image to fit within ${(maxSizeBytes / (1024 * 1024)).toFixed(1)} MB.`));
                  } else {
                    resolve(file);
                  }
                  return;
                }

                // Adaptive pass: if blob still exceeds maxSizeBytes and we have attempts left, reduce dimensions & quality
                if (maxSizeBytes && blob.size > maxSizeBytes && attemptCount < 3) {
                  const newW = Math.round(w * 0.75);
                  const newH = Math.round(h * 0.75);
                  const newQ = Math.max(0.5, q - 0.15);
                  attemptCompression(newW, newH, newQ, attemptCount + 1);
                  return;
                }

                // Final limit enforcement
                if (maxSizeBytes && blob.size > maxSizeBytes) {
                  reject(new Error(`Unable to compress image below ${(maxSizeBytes / (1024 * 1024)).toFixed(1)} MB limit. Please select a smaller photo.`));
                  return;
                }

                // Preserve filename with appropriate extension
                let fileName = file.name;
                if (
                  targetType === 'image/jpeg' &&
                  !fileName.toLowerCase().endsWith('.jpg') &&
                  !fileName.toLowerCase().endsWith('.jpeg')
                ) {
                  fileName = fileName.replace(/\.[^.]+$/, '') + '.jpg';
                }

                const compressedFile = new File([blob], fileName, {
                  type: targetType,
                  lastModified: Date.now(),
                });

                resolve(compressedFile);
              },
              targetType,
              q
            );
          };

          attemptCompression(currentWidth, currentHeight, currentQuality, 1);
        } catch (err) {
          if (maxSizeBytes && file.size > maxSizeBytes) {
            reject(new Error(`Image compression failed: ${(err as Error).message}`));
          } else {
            resolve(file);
          }
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
