import { describe, expect, it } from 'vitest';
import { firstPhotoOverlayFile, validatePhotoOverlayFile } from './file-validation';

describe('photo-overlay file validation', () => {
  it('accepts JPEG and PNG MIME types', () => {
    expect(validatePhotoOverlayFile(new File(['x'], 'photo.jpg', { type: 'image/jpeg' })).valid).toBe(true);
    expect(validatePhotoOverlayFile(new File(['x'], 'photo.jpeg', { type: 'image/jpeg' })).valid).toBe(true);
    expect(validatePhotoOverlayFile(new File(['x'], 'photo.png', { type: 'image/png' })).valid).toBe(true);
  });

  it('accepts an extension when the browser omitted the MIME type', () => {
    expect(validatePhotoOverlayFile(new File(['x'], 'photo.PNG')).valid).toBe(true);
  });

  it('rejects unsupported and conflicting files', () => {
    expect(validatePhotoOverlayFile(new File(['x'], 'photo.gif', { type: 'image/gif' })).valid).toBe(false);
    expect(validatePhotoOverlayFile(new File(['x'], 'photo.jpg', { type: 'image/gif' })).valid).toBe(false);
  });

  it('selects the first dropped file', () => {
    const first = new File(['one'], 'one.jpg', { type: 'image/jpeg' });
    const second = new File(['two'], 'two.png', { type: 'image/png' });
    expect(firstPhotoOverlayFile([first, second])).toBe(first);
    expect(firstPhotoOverlayFile([])).toBeNull();
  });
});
