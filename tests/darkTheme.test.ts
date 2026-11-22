import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';

const html = readFileSync('center-admin-v2.html', 'utf8');
const css = readFileSync('assets/platform-theme.css', 'utf8');
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
const properties = (selector: string) => {
  const rule = rules.find(row => row[1].trim() === selector);
  expect(rule, selector).toBeDefined();
  return Object.fromEntries(rule![2].split(';').filter(row => row.includes(':')).map(row => { const index = row.indexOf(':'); return [row.slice(0, index).trim(), row.slice(index + 1).trim()]; }));
};
function luminance(hex: string) {
  const full = hex.length === 4 ? '#' + [...hex.slice(1)].map(char => char + char).join('') : hex;
  const values = full.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
function contrast(a: string, b: string) { const first = luminance(a), second = luminance(b); return (Math.max(first, second) + .05) / (Math.min(first, second) + .05); }
const resolve = (value: string, tokens: Record<string, string>): string => value.startsWith('var(') ? tokens[value.slice(4, -1)] : value;

describe('shared platform color system', () => {
  it('loads the same-origin stylesheet after base styles and replaces the old dark-only block', () => {
    expect(html).toContain('<link rel="stylesheet" href="/assets/platform-theme.css">');
    expect(html.indexOf('/assets/platform-theme.css')).toBeGreaterThan(html.indexOf('</style>'));
    expect(html).not.toContain('/* TalimSAT-inspired dark surfaces.');
    expect(html).toContain('<html lang="ar" dir="rtl"');
    expect(css).not.toMatch(/@import|url\(|<script|onclick|direction\s*:/i);
  });
  it('serves only the fixed theme asset without login and with the correct MIME type', async () => {
    const app = buildApp();
    try { const response = await app.inject({ method: 'GET', url: '/assets/platform-theme.css' }); expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toContain('text/css'); expect(response.body).toBe(css); } finally { await app.close(); }
  });
  it('uses theme-aware KPI accents rather than fixed low-contrast icon colors', () => {
    for (const name of ['purple', 'teal', 'blue', 'amber']) expect(html).toContain('--kpi-color: var(--accent-' + name + ')');
    expect(html).not.toContain('--kpi-color: #');
  });
  it('keeps keyboard focus, hover, reduced-motion and forced-color affordances', () => {
    expect(css).toContain('textarea:focus-visible'); expect(css).toContain('summary:focus-visible');
    expect(css).toContain('outline: 3px solid var(--border-focus)');
    expect(css).toContain('(prefers-reduced-motion: reduce)'); expect(css).toContain('scroll-behavior: auto !important');
    expect(css).toContain('(forced-colors: active)'); expect(css).toContain('border: 2px solid Highlight');
    expect(css).toContain('.btn:disabled'); expect(css).toContain('.school-art { filter: none; }');
  });
  it('colors attendance summaries by their actual status, never by their position', () => {
    const attendance = readFileSync('assets/teacher-attendance.js', 'utf8');
    expect(attendance).toContain('data-attendance-summary="\' + item[0] + \'"');
    for (const [state, token] of [['present','ok'],['absent','er'],['late','wn'],['excused','info']]) expect(css).toMatch(new RegExp('\\[data-attendance-summary="' + state + '"\\][^{]*\\{ --summary-color: var\\(--' + token + '\\)'));
    expect(css).not.toMatch(/attendance-status-(present|absent|late|excused)\s*\{/);
  });
});
for (const theme of ['light', 'dark']) describe(theme + ' theme readability', () => {
  const tokens = properties('[data-theme="' + theme + '"]');
  const backgrounds = ['--bg-base', '--bg-surface', '--bg-surface-elevated', '--bg-surface-hover', '--pr-subtle', '--accent-purple-soft', '--accent-teal-soft', '--accent-blue-soft', '--accent-amber-soft', '--ok-glow', '--er-glow', '--wn-glow', '--info-glow'];
  it.each(['--tx', '--tx-muted', '--tx-dim'])('keeps %s readable on neutral, tinted and semantic cards', token => {
    for (const background of backgrounds) expect(contrast(tokens[token], tokens[background]), token + ' / ' + background).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['ok','er','wn','info'])('keeps the %s semantic label readable', token => {
    expect(contrast(tokens['--' + token], tokens['--' + token + '-glow'])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['purple','teal','blue','amber'])('keeps %s metric text and icons readable on their own tile', name => {
    expect(contrast(tokens['--accent-' + name], tokens['--accent-' + name + '-soft'])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['--action','--action-hover','--hero-start','--hero-end'])('keeps white text readable on %s', token => {
    expect(contrast('#ffffff', tokens[token])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['[data-theme] .btn-success','[data-theme] .btn-success:hover','[data-theme] .btn-danger','[data-theme] .btn-danger:hover','[data-theme] .school-dashboard-header .btn:not(.btn-secondary):not(.btn-success):not(.btn-danger)'])('keeps filled controls readable: %s', selector => {
    const values = properties(selector); expect(contrast(resolve(values.background, tokens), resolve(values.color || '#ffffff', tokens))).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps primary links and secondary controls readable', () => {
    for (const background of ['--bg-surface', '--bg-surface-elevated', '--bg-surface-hover', '--pr-subtle']) expect(contrast(tokens['--pr'], tokens[background])).toBeGreaterThanOrEqual(4.5);
  });
});
