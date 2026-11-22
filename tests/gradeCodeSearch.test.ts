import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const html = readFileSync('center-admin-v2.html', 'utf8');
const bootstrap = html.slice(html.indexOf('function newGradeEntry()'), html.indexOf('var GRADE_ENTRY', html.indexOf('function newGradeEntry()')));
const code = html.slice(html.indexOf('function gradeEntryError('), html.indexOf('function renderGradesView('));
function setup(api: (url: string) => Promise<unknown> = async () => ({ students: [{ id: 123, name: 'Assigned student' }] })) {
  const context: any = { STATE: { currentUser: { id: 'teacher' }, students: [{ id: 999, name: 'Unrelated cached pupil' }] }, localReportDate: () => '2026-11-22', safeText: (s: unknown) => String(s ?? ''), refreshMonthlyView() {}, api };
  runInNewContext(bootstrap + code, context); context.GRADE_ENTRY = context.newGradeEntry(); context.GRADE_ENTRY.mode = 'general'; context.GRADE_ENTRY.draft.groupId = '101'; return context;
}
describe('grade student code lookup', () => {
  it.each(['123', '#123', 'STUDENT:123', ' student:123 ', '١٢٣', '#۱۲۳'])('recognizes the fixed code %s', input => {
    expect(setup().gradeCodeStudentId(input)).toBe(123);
  });
  it.each(['', '0', '-1', '00123', '123.5', '1e3', 'STUDENT:-123', '#', '2147483648', 'Infinity', '<script>'])('rejects malformed or out-of-range code %s', input => {
    expect(setup().gradeCodeStudentId(input)).toBeNull();
  });
  it('accepts the largest supported student identifier', () => { expect(setup().gradeCodeStudentId('2147483647')).toBe(2147483647); });
  it('refreshes only the selected authorized roster and selects the exact matching code', async () => {
    const calls: string[] = [], c = setup(async url => { calls.push(url); return { students: [{ id: 123, name: 'Assigned student' }, { id: 1234, name: 'Different student' }] }; });
    c.GRADE_ENTRY.studentCode = 'STUDENT:123'; await c.searchGradeStudentCode();
    expect(calls).toEqual(['/api/center/grades/enrollments?groupId=101']);
    expect(c.GRADE_ENTRY.draft.studentId).toBe('123'); expect(c.GRADE_ENTRY.codeMessage).toContain('Assigned student'); expect(c.GRADE_ENTRY.codeBusy).toBe(false);
  });
  it('never uses an unrelated pupil from the global cache and clears the old selection on a miss', async () => {
    const c = setup(); c.GRADE_ENTRY.studentCode = '999'; c.GRADE_ENTRY.draft.studentId = '123'; await c.searchGradeStudentCode();
    expect(c.GRADE_ENTRY.draft.studentId).toBe(''); expect(c.GRADE_ENTRY.codeMessage).not.toContain('Unrelated cached pupil'); expect(c.GRADE_ENTRY.codeMessage).toContain('المجموعة المختارة');
  });
  it.each(['missing-group', 'invalid-code'])('does not request any roster for %s', async scenario => {
    let calls = 0; const c = setup(async () => { calls++; return {}; }); c.GRADE_ENTRY.studentCode = scenario === 'invalid-code' ? 'bad-code' : '123'; if (scenario === 'missing-group') c.GRADE_ENTRY.draft.groupId = '';
    await c.searchGradeStudentCode(); expect(calls).toBe(0); expect(c.GRADE_ENTRY.draft.studentId).toBe('');
  });
  it.each(['account', 'group'])('ignores a lookup completed after a %s change', async change => {
    let resolve!: (data: unknown) => void; const c = setup(() => new Promise(r => { resolve = r; })); const state = c.GRADE_ENTRY; state.studentCode = '123'; const pending = c.searchGradeStudentCode();
    if (change === 'account') { c.GRADE_ENTRY = c.newGradeEntry(); c.STATE.currentUser = { id: 'another-user' }; }
    else { state.draft.groupId = '202'; state.codeSequence++; state.codeBusy = false; }
    resolve({ students: [{ id: 123, name: 'Private old selection' }] }); await pending;
    expect(c.GRADE_ENTRY.draft.studentId).toBe(''); expect(c.GRADE_ENTRY.codeMessage).not.toContain('Private old selection');
  });
  it('reports a revoked assignment without retaining the previous roster or selection', async () => {
    const c = setup(async () => { throw { status: 404 }; }); c.GRADE_ENTRY.students = [{ id: 123, name: 'Old student' }]; c.GRADE_ENTRY.studentCode = '123'; await c.searchGradeStudentCode();
    expect(c.GRADE_ENTRY.students).toEqual([]); expect(c.GRADE_ENTRY.draft.studentId).toBe(''); expect(c.GRADE_ENTRY.codeBusy).toBe(false);
  });
  it('keeps scoped groups usable when only grade history fails and supports a later retry', async () => {
    let failed = true; const c = setup(async url => { if (url.endsWith('/groups')) return { groups: [{ groupId: 101, group: 'Own class', subject: 'Math' }] }; if (failed) throw { status: 500 }; return { items: [{ id: 'restored' }] }; });
    await c.loadGradeGroups(); await c.loadGradeRecords(); expect(c.GRADE_ENTRY.groups).toHaveLength(1); expect(c.GRADE_ENTRY.groupsError).toBe(''); expect(c.GRADE_ENTRY.error).toContain('HTTP 500');
    failed = false; await c.loadGradeRecords(); expect(c.GRADE_ENTRY.error).toBe(''); expect(c.GRADE_ENTRY.items[0].id).toBe('restored');
  });
  it.each([[401, 'جلسة'], [403, 'صلاحية'], [422, 'راجع'], [500, 'HTTP 500']])('explains HTTP %s without printing a raw server stack', (status, text) => {
    const c = setup(), error = c.gradeEntryError({ status, message: 'private raw SQL and server stack' }); expect(error).toContain(text); expect(error).not.toContain('private raw SQL');
  });
  it('explains an unlinked teacher profile rather than suggesting a reset', () => {
    expect(setup().gradeEntryError({ code: 'TEACHER_PROFILE_REQUIRED' })).toContain('غير مرتبط');
  });
  it('clears the prior selection and disables save as soon as a different code is typed', () => {
    const picker = { value: '123' }, status = { textContent: '' }, save = { disabled: false }, c = setup();
    c.document = { getElementById: (id: string) => ({ 'grade-student': picker, 'grade-code-status': status, 'grade-save-button': save })[id] };
    c.GRADE_ENTRY.draft.studentId = '123'; c.gradeCodeChanged('999');
    expect(c.GRADE_ENTRY.draft.studentId).toBe(''); expect(picker.value).toBe(''); expect(save.disabled).toBe(true); expect(status.textContent).toContain('بحث');
  });
  it('does not submit a grade while a newly typed code has no confirmed selection', () => {
    let writes = 0; const c = setup(async () => { writes++; return {}; });
    expect(c.saveGradeRecord({ preventDefault() {}, target: {} })).toBe(false); expect(writes).toBe(0);
  });
  it('does not overwrite a manual pupil selection with an earlier code lookup', async () => {
    let resolve!: (data: unknown) => void; const c = setup(() => new Promise(r => { resolve = r; })); c.GRADE_ENTRY.studentCode = '123';
    const pending = c.searchGradeStudentCode(); c.gradeStudentChanged('456'); resolve({ students: [{ id: 123, name: 'Old lookup' }] }); await pending;
    expect(c.GRADE_ENTRY.draft.studentId).toBe('456'); expect(c.GRADE_ENTRY.studentCode).toBe('456'); expect(c.GRADE_ENTRY.codeMessage).toBe('');
  });
  it('does not refill scoped groups after an account change', async () => {
    let resolve!: (data: unknown) => void; const c = setup(() => new Promise(r => { resolve = r; })); const pending = c.loadGradeGroups();
    c.GRADE_ENTRY = c.newGradeEntry(); c.STATE.currentUser = { id: 'new-user' }; resolve({ groups: [{ groupId: 101, group: 'Private class' }] }); await pending;
    expect(c.GRADE_ENTRY.groups).toEqual([]); expect(c.GRADE_ENTRY.groupsLoaded).toBe(false);
  });
  it('escapes code and selected-name feedback instead of treating either as HTML', async () => {
    const c = setup(async () => ({ students: [{ id: 123, name: '<img src=x onerror=attack()>' }] }));
    const safeCode = html.slice(html.indexOf('function safeText('), html.indexOf('function localReportDate(')); runInNewContext(safeCode, c);
    c.GRADE_ENTRY.studentCode = '123'; await c.searchGradeStudentCode(); c.GRADE_ENTRY.studentCode = '"><img src=x>';
    const markup = c.gradeStudentCodeSearchHtml(c.GRADE_ENTRY); expect(markup).not.toContain('<img'); expect(markup).toContain('&lt;img');
  });
  it('keeps code lookup separate from grade submission and permits keyboard search', () => {
    const c = setup(), markup = c.gradeStudentCodeSearchHtml(c.GRADE_ENTRY);
    expect(markup).toContain('type="button"'); expect(markup).toContain("event.key==='Enter'"); expect(markup).toContain('event.preventDefault();searchGradeStudentCode()'); expect(markup).toContain('role="status"');
  });
  it('preserves status and machine error code in the shared request helper', async () => {
    const apiCode = html.slice(html.indexOf('function api('), html.indexOf('function snack('));
    const c: any = { API_BASE: '', FormData: class {}, fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: 'FORBIDDEN', message: 'custom description' }) }) };
    runInNewContext(apiCode, c); await expect(c.api('/grades')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'custom description' });
  });
});
