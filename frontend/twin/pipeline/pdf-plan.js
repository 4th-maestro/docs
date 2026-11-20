const assets = new URL('../pdfjs/', import.meta.url);
const url = path => new URL(path, assets).href;

export const isPdf = file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

async function withPdf(file, readDocument) {
  const pdfjs = await import(url('build/pdf.min.mjs')).catch(() => { throw new Error('PDF 처리기를 불러오지 못했습니다. 페이지를 새로고침해 주세요.'); });
  pdfjs.GlobalWorkerOptions.workerSrc = url('build/pdf.worker.min.mjs');
  pdfjs.GlobalWorkerOptions.rendererSrc = url('build/pdf.renderer.min.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: url('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: url('standard_fonts/'),
    iccUrl: url('iccs/'),
    wasmUrl: url('wasm/'),
  });
  try {
    const pdf = await task.promise.catch(error => {
      if (error.name === 'PasswordException') throw new Error('암호가 걸린 PDF입니다. 잠금을 푼 사본을 선택하세요.');
      throw new Error('PDF를 열 수 없습니다. 파일을 확인해 주세요.');
    });
    return await readDocument(pdf, pdfjs);
  } finally {
    await task.destroy();
  }
}

export function planPageCount(file) {
  return withPdf(file, pdf => pdf.numPages);
}

export async function planImage(file, pageNumber = 1) {
  if (!isPdf(file)) return file;
  const png = await withPdf(file, async (pdf, pdfjs) => {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
      throw new Error(`PDF 페이지는 1~${pdf.numPages} 사이에서 고르세요.`);
    }
    const page = await pdf.getPage(pageNumber);
    const original = page.getViewport({ scale:1 });
    const scale = Math.min(4, 2400 / Math.max(original.width, original.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    try {
      await page.render({ canvas, viewport, background:'#ffffff', annotationMode:pdfjs.AnnotationMode.DISABLE }).promise;
      return await new Promise((resolve, reject) => canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('PDF 페이지를 이미지로 변환하지 못했습니다.')),
        'image/png',
      ));
    } finally {
      canvas.width = canvas.height = 0;
    }
  });
  return new File([png], file.name.replace(/\.pdf$/i, '') + '-p' + pageNumber + '.png', { type:'image/png' });
}
