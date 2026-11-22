import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync('center-admin-v2.html', 'utf8');
const marker = '/* TalimSAT-inspired dark surfaces.';
const css = html.slice(html.indexOf(marker), html.indexOf('</style>', html.indexOf(marker)));
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
const properties = (selector: string) => {
  const rule = rules.find(row => row[1].trim() === selector);
  expect(rule, selector).toBeDefined();
  return Object.fromEntries(rule![2].split(';').filter(row => row.includes(':')).map(row => { const index = row.indexOf(':'); return [row.slice(0, index).trim(), row.slice(index + 1).trim()]; }));
};
const tokens = properties('[data-theme="dark"]');
function luminance(hex: string) {
  const full = hex.length === 4 ? '#' + [...hex.slice(1)].map(char => char + char).join('') : hex;
  const values = full.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
function contrast(a: string, b: string) { const first = luminance(a), second = luminance(b); return (Math.max(first, second) + .05) / (Math.min(first, second) + .05); }

describe('dark-only graphite and blue theme', () => {
  it('scopes every added selector to dark mode and adds no copied assets or behavior', () => {
    expect(css.startsWith(marker)).toBe(true); expect(rules.length).toBeGreaterThan(60);
    for (const row of rules) for (const selector of row[1].split(',')) expect(selector.trim()).toMatch(/^\[data-theme="dark"\](?:\s|$)/);
    expect(css).not.toMatch(/@import|url\(|<script|onclick|direction\s*:/i);
    expect(html).toContain('<html lang="ar" dir="rtl"');
  });
  it('uses the inspected reference palette without changing the light tokens', () => {
    expect(tokens['--bg-base']).toBe('#171717'); expect(tokens['--bg-surface']).toBe('#272727');
    expect(properties('[data-theme="dark"] .nav-item.active').background).toBe('#205cdf');
    expect(properties('[data-theme="dark"] .btn:not(.btn-secondary):not(.btn-success):not(.btn-danger)').background).toBe('#205cdf');
    expect(css).not.toContain('[data-theme="light"]');
    expect(html).toContain('--bg-base: #f3f0e9; --bg-surface: #fff;');
  });
  it.each(['--tx', '--tx-muted', '--tx-dim'])('keeps %s readable on every neutral surface', token => {
    for (const background of ['--bg-base', '--bg-surface', '--bg-surface-elevated', '--bg-surface-hover']) expect(contrast(tokens[token], tokens[background])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['ok', 'er', 'wn', 'info'])('keeps the %s semantic label readable on its filled surface', token => {
    expect(contrast(tokens['--' + token], tokens['--' + token + '-glow'])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['[data-theme="dark"] .nav-item.active', '[data-theme="dark"] .btn:not(.btn-secondary):not(.btn-success):not(.btn-danger)', '[data-theme="dark"] .btn:not(.btn-secondary):not(.btn-success):not(.btn-danger):hover', '[data-theme="dark"] .btn-success', '[data-theme="dark"] .btn-success:hover', '[data-theme="dark"] .btn-danger', '[data-theme="dark"] .btn-danger:hover', '[data-theme="dark"] .attendance-status-neutral'])('keeps normal-sized filled text readable for %s', selector => {
    const values = properties(selector), foreground = values.color || '#fff';
    expect(contrast(values.background, foreground)).toBeGreaterThanOrEqual(4.5);
  });
});
