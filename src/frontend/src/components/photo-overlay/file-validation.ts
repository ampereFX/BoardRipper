const JPEG_MIME = 'image/jpeg';
const PNG_MIME = 'image/png';

export const PHOTO_OVERLAY_ACCEPT = '.jpg,.jpeg,.png,image/jpeg,image/png';

const acceptedExtensions = new Set(['jpg', 'jpeg', 'png']);
const acceptedMimeTypes = new Set([JPEG_MIME, PNG_MIME]);

export interface OverlayFileValidation {
  valid: boolean;
  message: string | null;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function validatePhotoOverlayFile(file: File | null | undefined): OverlayFileValidation {
  if (!file) return { valid: false, message: 'Choose a JPEG or PNG image.' };

  const extension = fileExtension(file.name);
  const mimeType = file.type.toLowerCase();
  const validMime = acceptedMimeTypes.has(mimeType);
  const validExtension = acceptedExtensions.has(extension);

  // Some file browsers leave File.type empty. In that case the extension is
  // the only useful signal. A conflicting, known MIME type is rejected.
  const valid = validMime || (mimeType === '' && validExtension);
  if (valid) return { valid: true, message: null };

  return {
    valid: false,
    message: 'Only JPEG (.jpg/.jpeg) and PNG (.png) images are supported.',
  };
}

export function firstPhotoOverlayFile(files: FileList | File[] | null | undefined): File | null {
  if (!files || files.length === 0) return null;
  return files[0] ?? null;
}
