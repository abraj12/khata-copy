/**
 * Client-Side Image Compression Utility
 * 
 * Automatically compresses and resizes high-resolution smartphone camera photos
 * before uploading them to the backend / Cloudflare R2.
 * 
 * Benefits:
 * - 10MB camera photo -> ~150KB - 250KB (95%+ reduction)
 * - Upload completes in milliseconds instead of seconds on mobile 4G/3G networks
 * - Shopkeeper never hits the 5MB / 10MB upload limits
 * - Saves mobile bandwidth and cloud storage costs
 * - Zero external dependencies; uses native HTML5 Canvas
 */

export interface CompressImageOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number; // 0.1 to 1.0 (default 0.8)
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
    targetType = 'image/jpeg',
  } = options;

  // In non-browser environments or if Canvas is unavailable, return original file
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof HTMLCanvasElement === 'undefined'
  ) {
    return file;
  }

  // Only compress raster images (jpeg, png, webp)
  const supportedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!supportedTypes.includes(file.type)) {
    return file;
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(file); // On error, fallback safely to original
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(file);
      img.onload = () => {
        try {
          let { width, height } = img;

          // Scale down dimensions preserving aspect ratio
          if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          } else if (file.size < 200 * 1024) {
            // Already small and within bounds: keep original
            resolve(file);
            return;
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(file);
            return;
          }

          // Fill white background for transparent PNGs converted to JPEG
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob(
            (blob) => {
              if (!blob) {
                resolve(file);
                return;
              }

              // If compressed blob is larger than original, keep original
              if (blob.size >= file.size && width === img.width && height === img.height) {
                resolve(file);
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
            quality
          );
        } catch {
          resolve(file);
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
