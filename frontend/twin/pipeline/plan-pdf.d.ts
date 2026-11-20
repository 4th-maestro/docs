export function pageSize(w: number, h: number, pxPerM?: number): { pt: [number, number]; scale?: number }
export function pdfBytes(w: number, h: number, rgb: Uint8Array, pt: [number, number]): Uint8Array
export function deflateRgb(data: Uint8ClampedArray | Uint8Array): Promise<Uint8Array>
export function planPdfPixels(
  image: { width: number; height: number; data: Uint8ClampedArray },
  pxPerM?: number,
): Promise<{ pdf: Blob; scale?: number; px: [number, number] }>
