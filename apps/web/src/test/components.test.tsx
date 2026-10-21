import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { dailyBuckets } from '@/components/charts';
import { ScoreRing, scoreTone, sourceName, StatusBadge } from '@/components/domain';
import { humanize, splitList } from '@/lib/utils';

describe('match indicator', () => {
  it('announces score and eligibility', () => {
    render(<ScoreRing match={{ score: 82, eligible: true, status: 'scored' }} />);
    expect(screen.getByRole('img', { name: '82% match' })).toBeInTheDocument();
    render(<ScoreRing match={{ score: 30, eligible: false, status: 'ineligible' }} />);
    expect(screen.getByRole('img', { name: '30% match, not eligible' })).toBeInTheDocument();
    render(<ScoreRing match={null} />);
    expect(screen.getByRole('img', { name: 'Not scored yet' })).toBeInTheDocument();
  });
  it('maps scores to tones, ineligible always rose', () => {
    expect(scoreTone(90, true)).toBe('jade');
    expect(scoreTone(60, true)).toBe('amber');
    expect(scoreTone(95, false)).toBe('rose');
    expect(scoreTone(null)).toBe('neutral');
  });
});

describe('labels', () => {
  it('renders status badges and source credits', () => {
    render(<MemoryRouter><StatusBadge status="awaiting_approval" /></MemoryRouter>);
    expect(screen.getByText('Awaiting Approval')).toBeInTheDocument();
    expect(sourceName('gmail_alert:linkedin')).toBe('Linkedin alert');
    expect(sourceName('remotive')).toBe('Remotive');
  });
  it('formats helpers', () => {
    expect(humanize('draft_prepared')).toBe('Draft prepared');
    expect(splitList('react, node\nsql,,')).toEqual(['react', 'node', 'sql']);
  });
  it('buckets dates per day', () => {
    const rows = [{ at: new Date().toISOString() }, { at: new Date().toISOString() }, { at: '2001-01-01T00:00:00Z' }];
    const b = dailyBuckets(rows, (r) => r.at, 7, 'jobs');
    expect(b).toHaveLength(7);
    expect(b.at(-1)!.jobs).toBe(2);
  });
});
