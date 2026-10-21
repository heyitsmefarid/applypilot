export const PDF = 'application/pdf';
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/**
 * Extracts plain text from a resume in the browser (pdf.js / mammoth), so the Worker never has
 * to parse binary files. Libraries are loaded on demand to keep the main bundle small.
 */
export async function extractResumeText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  if (file.type === PDF || file.name.toLowerCase().endsWith('.pdf')) {
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 10); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      let lastY: number | null = null;
      const lines: string[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          lines.push(line.trim());
          line = '';
        }
        line += item.str + (item.hasEOL ? '\n' : ' ');
        lastY = y;
      }
      if (line.trim()) lines.push(line.trim());
      pages.push(lines.filter(Boolean).join('\n'));
    }
    return pages.join('\n\n').replace(/[ \t]+/g, ' ').trim();
  }
  if (file.type === DOCX || file.name.toLowerCase().endsWith('.docx')) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value.replace(/\n{3,}/g, '\n\n').trim();
  }
  throw new Error('Only PDF and DOCX resumes are supported.');
}
