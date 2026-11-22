import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const html = readFileSync('center-admin-v2.html', 'utf8');
const code = html.slice(html.indexOf('function syncThemeButtons('), html.indexOf('/* ==========================================================================', html.indexOf('function syncThemeButtons(')));
function setup(saved?: string) {
  const storage = new Map(saved ? [['center_theme', saved]] : []), attributes: Record<string, string> = { 'data-theme': 'light' }, buttonAttributes: Record<string, string> = {}, label = { textContent: '' };
  const context: any = { document: { documentElement: { getAttribute: (key: string) => attributes[key], setAttribute: (key: string, value: string) => { attributes[key] = value; } }, querySelectorAll: () => [{ setAttribute: (key: string, value: string) => { buttonAttributes[key] = value; }, querySelector: () => label }] }, localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) } };
  runInNewContext(code, context); return { context, storage, attributes, buttonAttributes, label };
}
describe('logged-out landing theme control', () => {
  it('places a native keyboard-operable button before the sign-in link', () => {
    const navigation = html.slice(html.indexOf('<header class="school-nav"'), html.indexOf('</header>', html.indexOf('<header class="school-nav"')));
    expect(navigation).toContain('class="school-theme-toggle" type="button"');
    expect(navigation.indexOf('data-theme-toggle')).toBeLessThan(navigation.indexOf('class="school-nav-login"'));
    expect(navigation).toContain('onclick="toggleTheme()"');
    expect(navigation).toContain('aria-pressed="false"');
  });
  it('starts light and announces the available dark action', () => {
    const s = setup(); s.context.initTheme(); expect(s.attributes['data-theme']).toBe('light'); expect(s.label.textContent).toBe('الوضع الداكن'); expect(s.buttonAttributes['aria-pressed']).toBe('false');
  });
  it('switches both ways and persists the same preference as the signed-in control', () => {
    const s = setup(); s.context.initTheme(); s.context.toggleTheme(); expect(s.attributes['data-theme']).toBe('dark'); expect(s.storage.get('center_theme')).toBe('dark'); expect(s.label.textContent).toBe('الوضع الفاتح'); expect(s.buttonAttributes['aria-pressed']).toBe('true');
    s.context.toggleTheme(); expect(s.attributes['data-theme']).toBe('light'); expect(s.storage.get('center_theme')).toBe('light'); expect(s.buttonAttributes['aria-label']).toBe('تفعيل الوضع الداكن');
  });
  it('restores dark mode and the correct action label on reload', () => {
    const s = setup('dark'); s.context.initTheme(); expect(s.attributes['data-theme']).toBe('dark'); expect(s.buttonAttributes['aria-label']).toBe('تفعيل الوضع الفاتح');
  });
});
