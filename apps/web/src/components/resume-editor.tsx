import { SKILL_CATEGORIES, type ResumeData } from '@applypilot/core';
import { Plus, Trash2, X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Field, Input, NativeSelect, Textarea } from './ui/form';

const lines = (s: string) => s.split('\n').map((l) => l.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
const csv = (s: string) => s.split(',').map((l) => l.trim()).filter(Boolean);

function Section({ title, onAdd, addLabel, children }: { title: string; onAdd?: () => void; addLabel?: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between">
        <legend className="text-[14px] font-semibold">{title}</legend>
        {onAdd && (
          <Button type="button" size="sm" variant="ghost" onClick={onAdd}>
            <Plus /> {addLabel}
          </Button>
        )}
      </div>
      {children}
    </fieldset>
  );
}

function Item({ onRemove, label, children }: { onRemove: () => void; label: string; children: React.ReactNode }) {
  return (
    <div className="relative grid gap-3 rounded-[var(--radius-control)] border border-line p-3 sm:grid-cols-2">
      <button type="button" onClick={onRemove} className="absolute right-2 top-2 rounded p-1 text-muted hover:bg-rose-soft hover:text-rose" aria-label={`Remove ${label}`}>
        <Trash2 className="size-3.5" />
      </button>
      {children}
    </div>
  );
}

/**
 * Structured resume editor. Bullets are one per line; technologies are comma-separated.
 * Bullet text is edited as a draft string so typing new lines isn't fought by parsing.
 */
export function ResumeEditor({ value, onChange }: { value: ResumeData; onChange: (r: ResumeData) => void }) {
  const set = (patch: Partial<ResumeData>) => onChange({ ...value, ...patch });
  const b = value.basics;
  const [skillDraft, setSkillDraft] = React.useState('');
  const [skillCat, setSkillCat] = React.useState<(typeof SKILL_CATEGORIES)[number]>('framework');

  const update = <K extends 'experience' | 'education' | 'projects' | 'certifications'>(key: K, i: number, patch: Partial<ResumeData[K][number]>) =>
    set({ [key]: value[key].map((x, j) => (j === i ? { ...x, ...patch } : x)) } as Partial<ResumeData>);
  const remove = (key: 'experience' | 'education' | 'projects' | 'certifications', i: number) => set({ [key]: value[key].filter((_, j) => j !== i) } as Partial<ResumeData>);

  return (
    <div className="grid gap-5">
      <Section title="Contact & summary">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name"><Input value={b.name} onChange={(e) => set({ basics: { ...b, name: e.target.value } })} /></Field>
          <Field label="Headline"><Input value={b.headline} placeholder="e.g. Computer Science student · Full-stack developer" onChange={(e) => set({ basics: { ...b, headline: e.target.value } })} /></Field>
          <Field label="Email"><Input type="email" value={b.email} onChange={(e) => set({ basics: { ...b, email: e.target.value } })} /></Field>
          <Field label="Phone"><Input value={b.phone} onChange={(e) => set({ basics: { ...b, phone: e.target.value } })} /></Field>
          <Field label="Location"><Input value={b.location} onChange={(e) => set({ basics: { ...b, location: e.target.value } })} /></Field>
          <Field label="Links" hint="One per line: Label | URL">
            <Textarea
              rows={2}
              defaultValue={b.links.map((l) => `${l.label} | ${l.url}`).join('\n')}
              onBlur={(e) => set({ basics: { ...b, links: lines(e.target.value).map((l) => { const [label = '', url = ''] = l.includes('|') ? l.split('|').map((x) => x.trim()) : ['', l]; return { label, url }; }) } })}
            />
          </Field>
        </div>
        <Field label="Professional summary"><Textarea rows={3} value={b.summary} onChange={(e) => set({ basics: { ...b, summary: e.target.value } })} /></Field>
      </Section>

      <Section title={`Skills (${value.skills.length})`}>
        <div className="flex flex-wrap gap-1.5">
          {value.skills.map((s, i) => (
            <span key={`${s.name}-${i}`} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2/60 py-0.5 pl-2.5 pr-1 text-xs">
              {s.name}
              <span className="text-muted">· {s.category}</span>
              <button type="button" className="rounded-full p-0.5 text-muted hover:text-rose" aria-label={`Remove ${s.name}`} onClick={() => set({ skills: value.skills.filter((_, j) => j !== i) })}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Input aria-label="New skill" className="max-w-56" placeholder="Add a skill you actually have" value={skillDraft} onChange={(e) => setSkillDraft(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter' && skillDraft.trim()) {
              e.preventDefault();
              set({ skills: [...value.skills, { name: skillDraft.trim(), category: skillCat }] });
              setSkillDraft('');
            }
          }} />
          <NativeSelect aria-label="Skill category" className="w-36" value={skillCat} onChange={(e) => setSkillCat(e.target.value as typeof skillCat)}>
            {SKILL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </NativeSelect>
          <Button type="button" size="md" disabled={!skillDraft.trim()} onClick={() => { set({ skills: [...value.skills, { name: skillDraft.trim(), category: skillCat }] }); setSkillDraft(''); }}>
            Add skill
          </Button>
        </div>
      </Section>

      <Section title="Experience" addLabel="Add experience" onAdd={() => set({ experience: [...value.experience, { company: '', title: '', location: '', start_date: '', end_date: '', current: false, highlights: [] }] })}>
        {value.experience.length === 0 && <p className="text-xs text-muted">Internships, freelance and part-time work count.</p>}
        {value.experience.map((e, i) => (
          <Item key={i} label={`experience ${e.title || i + 1}`} onRemove={() => remove('experience', i)}>
            <Field label="Title"><Input value={e.title} onChange={(ev) => update('experience', i, { title: ev.target.value })} /></Field>
            <Field label="Company"><Input value={e.company} onChange={(ev) => update('experience', i, { company: ev.target.value })} /></Field>
            <Field label="Start"><Input value={e.start_date} placeholder="Jun 2024" onChange={(ev) => update('experience', i, { start_date: ev.target.value })} /></Field>
            <Field label="End"><Input value={e.current ? 'Present' : e.end_date} disabled={e.current} onChange={(ev) => update('experience', i, { end_date: ev.target.value })} /></Field>
            <Field label="Highlights" hint="One bullet per line" className="sm:col-span-2">
              <Textarea rows={3} defaultValue={e.highlights.join('\n')} onBlur={(ev) => update('experience', i, { highlights: lines(ev.target.value) })} />
            </Field>
          </Item>
        ))}
      </Section>

      <Section title="Projects" addLabel="Add project" onAdd={() => set({ projects: [...value.projects, { name: '', role: '', url: '', technologies: [], highlights: [] }] })}>
        {value.projects.map((p, i) => (
          <Item key={i} label={`project ${p.name || i + 1}`} onRemove={() => remove('projects', i)}>
            <Field label="Name"><Input value={p.name} onChange={(ev) => update('projects', i, { name: ev.target.value })} /></Field>
            <Field label="URL"><Input value={p.url} onChange={(ev) => update('projects', i, { url: ev.target.value })} /></Field>
            <Field label="Technologies" hint="Comma-separated" className="sm:col-span-2">
              <Input defaultValue={p.technologies.join(', ')} onBlur={(ev) => update('projects', i, { technologies: csv(ev.target.value) })} />
            </Field>
            <Field label="Highlights" hint="One bullet per line" className="sm:col-span-2">
              <Textarea rows={3} defaultValue={p.highlights.join('\n')} onBlur={(ev) => update('projects', i, { highlights: lines(ev.target.value) })} />
            </Field>
          </Item>
        ))}
      </Section>

      <Section title="Education" addLabel="Add education" onAdd={() => set({ education: [...value.education, { institution: '', degree: '', field: '', start_date: '', end_date: '', gpa: '', highlights: [] }] })}>
        {value.education.map((e, i) => (
          <Item key={i} label={`education ${e.institution || i + 1}`} onRemove={() => remove('education', i)}>
            <Field label="Institution"><Input value={e.institution} onChange={(ev) => update('education', i, { institution: ev.target.value })} /></Field>
            <Field label="Degree"><Input value={e.degree} onChange={(ev) => update('education', i, { degree: ev.target.value })} /></Field>
            <Field label="Start"><Input value={e.start_date} onChange={(ev) => update('education', i, { start_date: ev.target.value })} /></Field>
            <Field label="End (or expected)"><Input value={e.end_date} onChange={(ev) => update('education', i, { end_date: ev.target.value })} /></Field>
          </Item>
        ))}
      </Section>

      <Section title="Certifications" addLabel="Add certification" onAdd={() => set({ certifications: [...value.certifications, { name: '', issuer: '', date: '', url: '' }] })}>
        {value.certifications.map((c, i) => (
          <Item key={i} label={`certification ${c.name || i + 1}`} onRemove={() => remove('certifications', i)}>
            <Field label="Name"><Input value={c.name} onChange={(ev) => update('certifications', i, { name: ev.target.value })} /></Field>
            <Field label="Issuer"><Input value={c.issuer} onChange={(ev) => update('certifications', i, { issuer: ev.target.value })} /></Field>
          </Item>
        ))}
      </Section>
    </div>
  );
}

/** Read-only rendering used for previews and side-by-side comparison. */
export function ResumeView({ value, highlight, className }: { value: ResumeData; highlight?: (text: string) => boolean; className?: string }) {
  const mark = (t: string) => (highlight?.(t) ? 'rounded-sm bg-jade-soft/80 px-0.5' : undefined);
  const b = value.basics;
  return (
    <article className={cn('grid gap-4 text-[13px] leading-relaxed', className)}>
      <header>
        <h3 className="type-display text-xl">{b.name || 'Unnamed'}</h3>
        {b.headline && <p className={cn('text-ink-2', mark(b.headline))}>{b.headline}</p>}
        <p className="text-xs text-muted">{[b.location, b.email, b.phone, ...b.links.map((l) => l.url)].filter(Boolean).join(' | ')}</p>
      </header>
      {b.summary && <p className={mark(b.summary)}>{b.summary}</p>}
      {value.skills.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">Skills</h4>
          <p className="text-ink-2">{value.skills.map((s) => s.name).join(', ')}</p>
        </section>
      )}
      {value.experience.length > 0 && (
        <section className="grid gap-2">
          <h4 className="font-semibold">Experience</h4>
          {value.experience.map((e, i) => (
            <div key={i}>
              <p className="font-medium">{e.title} — {e.company} <span className="font-normal text-muted">({e.start_date} – {e.current ? 'Present' : e.end_date})</span></p>
              <ul className="list-disc pl-5">{e.highlights.map((h, j) => <li key={j} className={mark(h)}>{h}</li>)}</ul>
            </div>
          ))}
        </section>
      )}
      {value.projects.length > 0 && (
        <section className="grid gap-2">
          <h4 className="font-semibold">Projects</h4>
          {value.projects.map((p, i) => (
            <div key={i}>
              <p className="font-medium">{p.name} <span className="font-normal text-muted">{p.technologies.join(', ')}</span></p>
              <ul className="list-disc pl-5">{p.highlights.map((h, j) => <li key={j} className={mark(h)}>{h}</li>)}</ul>
            </div>
          ))}
        </section>
      )}
      {value.education.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">Education</h4>
          {value.education.map((e, i) => <p key={i}>{e.degree}{e.field ? `, ${e.field}` : ''} — {e.institution} <span className="text-muted">({e.start_date} – {e.end_date})</span></p>)}
        </section>
      )}
      {value.certifications.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold">Certifications</h4>
          {value.certifications.map((c, i) => <p key={i}>{c.name}{c.issuer ? ` — ${c.issuer}` : ''}</p>)}
        </section>
      )}
    </article>
  );
}
