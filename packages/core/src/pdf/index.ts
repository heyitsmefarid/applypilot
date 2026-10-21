import { jsPDF } from 'jspdf';
import type { ResumeData } from '../schemas/resume.js';

/**
 * ATS-friendly PDFs: single column, standard font, real (selectable) text, simple headings,
 * no tables, images or columns. Works in browsers and Node (runner).
 */

const PAGE = { width: 612, height: 792, margin: 54 }; // US Letter in points, 0.75in margins
const COLORS = { text: [20, 23, 28] as const, muted: [90, 96, 105] as const, rule: [200, 204, 210] as const };

class Writer {
  doc: jsPDF;
  y = PAGE.margin;
  readonly maxWidth = PAGE.width - PAGE.margin * 2;

  constructor(title: string, author: string) {
    this.doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true });
    this.doc.setProperties({ title, author, creator: 'ApplyPilot AI', subject: title });
    this.doc.setFont('helvetica', 'normal');
  }

  ensure(height: number) {
    if (this.y + height > PAGE.height - PAGE.margin) {
      this.doc.addPage();
      this.y = PAGE.margin;
    }
  }

  text(content: string, opts: { size?: number; bold?: boolean; color?: readonly [number, number, number]; indent?: number; gap?: number; align?: 'left' | 'center' } = {}) {
    const size = opts.size ?? 10.5;
    const indent = opts.indent ?? 0;
    this.doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    this.doc.setFontSize(size);
    const c = opts.color ?? COLORS.text;
    this.doc.setTextColor(c[0], c[1], c[2]);
    const lines = this.doc.splitTextToSize(content, this.maxWidth - indent) as string[];
    const lineHeight = size * 1.32;
    for (const line of lines) {
      this.ensure(lineHeight);
      const x = opts.align === 'center' ? PAGE.width / 2 : PAGE.margin + indent;
      this.doc.text(line, x, this.y + size, { align: opts.align ?? 'left' });
      this.y += lineHeight;
    }
    this.y += opts.gap ?? 0;
  }

  bullet(content: string) {
    const size = 10.5;
    this.doc.setFont('helvetica', 'normal');
    this.doc.setFontSize(size);
    const lines = this.doc.splitTextToSize(content, this.maxWidth - 14) as string[];
    const lineHeight = size * 1.32;
    lines.forEach((line, i) => {
      this.ensure(lineHeight);
      this.doc.setTextColor(COLORS.text[0], COLORS.text[1], COLORS.text[2]);
      if (i === 0) this.doc.text('•', PAGE.margin + 2, this.y + size);
      this.doc.text(line, PAGE.margin + 14, this.y + size);
      this.y += lineHeight;
    });
  }

  heading(label: string) {
    this.ensure(30);
    this.y += 8;
    this.text(label.toUpperCase(), { size: 10.5, bold: true, gap: 2 });
    this.doc.setDrawColor(COLORS.rule[0], COLORS.rule[1], COLORS.rule[2]);
    this.doc.setLineWidth(0.6);
    this.doc.line(PAGE.margin, this.y, PAGE.width - PAGE.margin, this.y);
    this.y += 6;
  }

  /** Left text with right-aligned dates on the same line. */
  row(left: string, right: string, bold = true) {
    const size = 10.5;
    this.ensure(size * 1.4);
    this.doc.setFontSize(size);
    this.doc.setFont('helvetica', bold ? 'bold' : 'normal');
    this.doc.setTextColor(COLORS.text[0], COLORS.text[1], COLORS.text[2]);
    const rightWidth = right ? this.doc.getTextWidth(right) + 12 : 0;
    const leftLines = this.doc.splitTextToSize(left, this.maxWidth - rightWidth) as string[];
    this.doc.text(leftLines[0] ?? '', PAGE.margin, this.y + size);
    if (right) {
      this.doc.setFont('helvetica', 'normal');
      this.doc.setTextColor(COLORS.muted[0], COLORS.muted[1], COLORS.muted[2]);
      this.doc.text(right, PAGE.width - PAGE.margin, this.y + size, { align: 'right' });
    }
    this.y += size * 1.35;
    for (const extra of leftLines.slice(1)) this.text(extra, { bold });
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.doc.output('arraybuffer'));
  }
}

const range = (start: string, end: string, current = false) => [start, current ? 'Present' : end].filter(Boolean).join(' – ');

export function renderResumePdf(resume: ResumeData): Uint8Array {
  const b = resume.basics;
  const w = new Writer(`${b.name || 'Resume'} — Resume`, b.name);
  w.text(b.name || 'Your Name', { size: 20, bold: true, align: 'center', gap: 2 });
  if (b.headline) w.text(b.headline, { size: 11, color: COLORS.muted, align: 'center', gap: 2 });
  const contact = [b.location, b.email, b.phone, ...b.links.map((l) => l.url.replace(/^https?:\/\//, ''))].filter(Boolean).join('  |  ');
  if (contact) w.text(contact, { size: 9.5, color: COLORS.muted, align: 'center', gap: 4 });

  if (b.summary) {
    w.heading('Summary');
    w.text(b.summary);
  }
  if (resume.skills.length) {
    w.heading('Technical Skills');
    const groups = new Map<string, string[]>();
    for (const s of resume.skills) {
      const label = { language: 'Languages', framework: 'Frameworks', library: 'Libraries', database: 'Databases', tool: 'Tools', cloud: 'Cloud', platform: 'Platforms', soft: 'Soft skills', other: 'Other' }[s.category];
      groups.set(label, [...(groups.get(label) ?? []), s.name]);
    }
    for (const [label, items] of groups) w.text(`${label}: ${items.join(', ')}`);
  }
  if (resume.experience.length) {
    w.heading('Experience');
    for (const e of resume.experience) {
      w.row(`${e.title}${e.company ? ` — ${e.company}` : ''}`, range(e.start_date, e.end_date, e.current));
      if (e.location) w.text(e.location, { size: 9.5, color: COLORS.muted });
      for (const h of e.highlights) w.bullet(h);
      w.y += 4;
    }
  }
  if (resume.projects.length) {
    w.heading('Projects');
    for (const p of resume.projects) {
      w.row(`${p.name}${p.role ? ` — ${p.role}` : ''}`, p.url.replace(/^https?:\/\//, ''));
      if (p.technologies.length) w.text(`Technologies: ${p.technologies.join(', ')}`, { size: 9.5, color: COLORS.muted });
      for (const h of p.highlights) w.bullet(h);
      w.y += 4;
    }
  }
  if (resume.education.length) {
    w.heading('Education');
    for (const e of resume.education) {
      w.row(`${[e.degree, e.field].filter(Boolean).join(', ')}${e.institution ? ` — ${e.institution}` : ''}`, range(e.start_date, e.end_date));
      if (e.gpa) w.text(`GPA: ${e.gpa}`, { size: 9.5, color: COLORS.muted });
      for (const h of e.highlights) w.bullet(h);
      w.y += 4;
    }
  }
  if (resume.certifications.length) {
    w.heading('Certifications');
    for (const c of resume.certifications) w.row(`${c.name}${c.issuer ? ` — ${c.issuer}` : ''}`, c.date, false);
  }
  return w.bytes();
}

export interface LetterInput {
  senderName: string;
  senderContact: string[];
  date: string;
  recipient?: string;
  greeting: string;
  paragraphs: string[];
  closing: string;
  signature?: string;
}

export function renderLetterPdf(letter: LetterInput): Uint8Array {
  const w = new Writer(`${letter.senderName} — Cover Letter`, letter.senderName);
  w.text(letter.senderName, { size: 16, bold: true, gap: 2 });
  if (letter.senderContact.length) w.text(letter.senderContact.filter(Boolean).join('  |  '), { size: 9.5, color: COLORS.muted, gap: 14 });
  w.text(letter.date, { gap: 10 });
  if (letter.recipient) w.text(letter.recipient, { gap: 10 });
  w.text(letter.greeting, { gap: 8 });
  for (const p of letter.paragraphs) w.text(p, { gap: 8 });
  w.text(letter.closing, { gap: 2 });
  w.text(letter.signature || letter.senderName, { bold: true });
  return w.bytes();
}
