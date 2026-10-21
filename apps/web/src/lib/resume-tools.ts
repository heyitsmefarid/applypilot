import type { ResumeData } from '@applypilot/core';
import type { LetterInput } from '@applypilot/core/pdf';

export { normalizeSkill, resumeDataSchema, type ResumeData } from '@applypilot/core';

/** jsPDF is only loaded when a PDF is exported. */
export async function renderResumePdfLazy(resume: ResumeData): Promise<Uint8Array> {
  const { renderResumePdf } = await import('@applypilot/core/pdf');
  return renderResumePdf(resume);
}

export async function renderLetterPdfLazy(input: LetterInput): Promise<Uint8Array> {
  const { renderLetterPdf } = await import('@applypilot/core/pdf');
  return renderLetterPdf(input);
}
