const NORMALIZED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

export interface NormalizedImageInfo {
  blob: Blob;
  width: number;
  height: number;
}

function imageType(source: Blob): string {
  const type = source.type.toLowerCase();
  if (!NORMALIZED_IMAGE_TYPES.has(type)) {
    throw new Error('Nur JPEG- und PNG-Bilder können normalisiert werden.');
  }
  return type;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Das normalisierte Bild konnte nicht erzeugt werden.'));
    }, type, type === 'image/jpeg' ? 0.95 : undefined);
  });
}

/**
 * Dekodiert ein JPEG/PNG mit der Browser-EXIF-Orientierung und schreibt es in
 * ein neues Canvas. createImageBitmap übernimmt dabei die EXIF-Drehung; das
 * Canvas enthält anschließend nur noch die sichtbare, orientierte Lage.
 */
export async function normalizePhotoImage(source: Blob): Promise<NormalizedImageInfo> {
  const type = imageType(source);
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });

  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Der 2D-Canvas-Kontext ist nicht verfügbar.');
    context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
    const blob = await canvasBlob(canvas, type);
    return { blob, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
