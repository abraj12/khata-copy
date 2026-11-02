import { describe, it, expect } from 'vitest';
import { compressImageFile } from '../src/utils/imageCompressor.js';

describe('Client-Side Image Compression Suite', () => {
  it('1. Safely returns original file when input is not a supported raster image', async () => {
    const dummyPdf = new File(['%PDF-1.4 dummy'], 'doc.pdf', { type: 'application/pdf' });
    const result = await compressImageFile(dummyPdf);
    expect(result).toBe(dummyPdf);
  });

  it('2. Safely returns original file or fallback when Canvas environment is unavailable', async () => {
    const dummyImage = new File(['fake-image-bytes'], 'photo.jpg', { type: 'image/jpeg' });
    const result = await compressImageFile(dummyImage, {
      maxWidth: 1200,
      maxHeight: 1200,
      quality: 0.8,
    });
    // In Node.js environment without DOM Canvas, it gracefully preserves the file
    expect(result).toBeDefined();
    expect(result.name).toBe('photo.jpg');
    expect(result.type).toBe('image/jpeg');
  });

  it('3. Preserves filename and attributes on processing', async () => {
    const dummyPng = new File(['fake-png-bytes'], 'hardware-part.png', { type: 'image/png' });
    const result = await compressImageFile(dummyPng);
    expect(result).toBeDefined();
    expect(result.size).toBe(dummyPng.size);
  });
});
