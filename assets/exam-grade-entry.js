// Exam-selected grade entry and shared exam-form code lookup.
function examResultStudentChanged(value) {
  var state = EXAM_PAGE; state.score = ''; state.resultCodeSequence++; state.resultCodeBusy = false; state.studentId = value; state.resultCode = value; state.resultCodeMessage = ''; refreshExamPage();
}
function examResultCodeChanged(value) {
  var state = EXAM_PAGE; state.score = ''; var score = document.getElementById('exam-result-score'); if (score) score.value = ''; state.resultCode = value; state.studentId = ''; state.resultCodeSequence++; state.resultCodeBusy = false; state.resultCodeMessage = value.trim() ? 'اضغط بحث لاختيار الطالب قبل الحفظ.' : '';
  var picker = document.getElementById('exam-result-student'), status = document.getElementById('exam-result-code-status'), save = document.getElementById('exam-result-save');
  if (picker) picker.value = ''; if (status) status.textContent = state.resultCodeMessage; if (save) save.disabled = true;
}
function searchExamResultStudentCode() {
  var state = EXAM_PAGE, userId = STATE.currentUser && STATE.currentUser.id, id = state.selected;
  if (state.busy || state.resultCodeBusy || !id || !state.detail || state.detail.exam.publishedAt) return Promise.resolve();
  state.studentId = ''; var studentId = gradeCodeStudentId(state.resultCode);
  if (studentId === null) { state.resultCodeMessage = 'أدخل كود الطالب فقط: الرقم أو STUDENT: ثم الرقم أو # ثم الرقم.'; refreshExamPage(); return Promise.resolve(); }
  var sequence = ++state.resultCodeSequence; state.resultCodeBusy = true; state.resultCodeMessage = ''; refreshExamPage();
  return api('/api/center/exams/' + encodeURIComponent(id) + '/results').then(function(data) {
    if (!examCurrent(state, userId) || sequence !== state.resultCodeSequence || state.selected !== id) return;
    state.detail = data; var student = data.students.find(function(row) { return row.id === studentId; });
    if (data.exam.publishedAt) state.resultCodeMessage = 'نشرت نتائج الامتحان. الإضافة مغلقة.';
    else if (student && !student.result) { state.studentId = String(student.id); state.resultCodeMessage = 'تم اختيار ' + student.name + ' #' + student.id + '.'; }
    else state.resultCodeMessage = student ? 'لهذا الطالب نتيجة مسجلة. استخدم سجل الدرجة للتصحيح.' : 'لا يوجد طالب بهذا الكود ضمن مجموعة الامتحان المتاحة لحسابك.';
  }).catch(function(error) { if (examCurrent(state, userId) && sequence === state.resultCodeSequence) state.resultCodeMessage = gradeEntryError(error); })
    .finally(function() { if (examCurrent(state, userId) && sequence === state.resultCodeSequence) { state.resultCodeBusy = false; refreshExamPage(); } });
}
function examResultCodeSearchHtml(state) {
  return '<div class="field"><label for="exam-result-code">أو ابحث بكود الطالب فقط</label><input id="exam-result-code" type="text" dir="ltr" inputmode="text" autocomplete="off" placeholder="STUDENT:1001" value="' + safeText(state.resultCode) + '" oninput="examResultCodeChanged(this.value)" onkeydown="if(event.key===\'Enter\'){event.preventDefault();searchExamResultStudentCode();}"></div><button class="btn btn-secondary" type="button" onclick="searchExamResultStudentCode()"' + (state.resultCodeBusy ? ' disabled' : '') + '>' + (state.resultCodeBusy ? 'جارٍ البحث...' : 'بحث بالكود') + '</button>';
}


function gradeEntryModeHtml(state) {
  return '<div class="monthly-controls grade-entry-modes"><button class="btn' + (state.mode === 'exam' ? '' : ' btn-secondary') + '" type="button" onclick="setGradeEntryMode(\'exam\')"' + (state.saving ? ' disabled' : '') + '>درجات امتحان محدد، مسودة</button><button class="btn' + (state.mode === 'general' ? '' : ' btn-secondary') + '" type="button" onclick="setGradeEntryMode(\'general\')"' + (state.saving ? ' disabled' : '') + '>تقييم عام بدون امتحان، يظهر فور الحفظ</button></div>';
}
function clearGradeExamSelection(state) {
  state.selectedExamId = ''; state.selectedExam = null; state.examDetailSequence++; state.examDetailLoading = false; state.examDetailError = ''; state.enrollmentSequence++; state.codeSequence++; state.codeBusy = false; state.enrollmentLoading = false; state.enrollmentError = ''; state.students = []; state.studentCode = ''; state.codeMessage = ''; state.message = '';
  state.draft = { groupId: '', studentId: '', title: '', assessedOn: localReportDate(), score: '', maxScore: '100' };
}
function setGradeEntryMode(mode) {
  var state = GRADE_ENTRY; if (state.saving || (mode !== 'exam' && mode !== 'general')) return;
  clearGradeExamSelection(state); state.mode = mode; state.examsSequence++; state.examsLoading = false; state.examsLoaded = false; state.examsError = ''; state.groupsSequence++; state.groupsLoading = false; state.groupsLoaded = false; state.groupsError = ''; state.sequence++; state.loading = false; state.loaded = false; state.error = ''; refreshMonthlyView('grades');
}
function gradeExamMonthChanged(value) {
  var state = GRADE_ENTRY; if (state.saving) return; clearGradeExamSelection(state); state.examMonth = value; state.examsLoaded = false; return loadGradeExams();
}
function gradeExamError(error) {
  var messages = { RESULT_ALREADY_RECORDED: 'هذه النتيجة مسجلة بالفعل. استخدم سجل الدرجة للتصحيح، ولم تضاف نسخة جديدة.', EXAM_RESULTS_PUBLISHED: 'نشرت نتائج هذا الامتحان، ولا يمكن إضافة درجات جديدة. التصحيح له صلاحية وسجل مستقلان.', EXAM_NOT_FOUND: 'الامتحان لم يعد متاحا ضمن صلاحياتك. حدث قائمة الامتحانات.', STUDENT_NOT_ENROLLED: 'الطالب غير مقيد حاليا بمجموعة هذا الامتحان.', SCORE_EXCEEDS_MAXIMUM: 'الدرجة أكبر من الدرجة العظمى للامتحان.', INVALID_INPUT: 'راجع الطالب والدرجة المدخلة.' };
  return messages[error.code || error.message] || gradeEntryError(error);
}
function loadGradeExams() {
  var state = GRADE_ENTRY, sequence = ++state.examsSequence, userId = STATE.currentUser && STATE.currentUser.id; state.examsLoading = true; state.examsError = ''; refreshMonthlyView('grades');
  return api('/api/center/grades/exams?month=' + encodeURIComponent(state.examMonth)).then(function(data) {
    if (!gradeEntryCurrent(state, userId) || sequence !== state.examsSequence || state.mode !== 'exam') return;
    state.exams = data.exams || []; state.examsLoaded = true; state.canManageExams = !!data.canManageExams;
    if (state.selectedExamId && !state.exams.some(function(exam) { return exam.id === state.selectedExamId; })) clearGradeExamSelection(state);
  }).catch(function(error) { if (gradeEntryCurrent(state, userId) && sequence === state.examsSequence) { state.exams = []; state.examsError = gradeExamError(error); clearGradeExamSelection(state); } })
    .finally(function() { if (gradeEntryCurrent(state, userId) && sequence === state.examsSequence) { state.examsLoading = false; refreshMonthlyView('grades'); } });
}
function applyGradeExamDetail(state, data) {
  state.selectedExam = data.exam; state.students = data.students || []; state.draft.groupId = String(data.exam.groupId); state.draft.title = data.exam.title; state.draft.assessedOn = data.exam.date; state.draft.maxScore = String(data.exam.maxScore);
}
function selectGradeExam(id) {
  var state = GRADE_ENTRY; if (state.saving) return Promise.resolve(); clearGradeExamSelection(state); state.selectedExamId = id; refreshMonthlyView('grades'); return id ? loadSelectedGradeExam() : Promise.resolve();
}
function loadSelectedGradeExam() {
  var state = GRADE_ENTRY, id = state.selectedExamId, sequence = ++state.examDetailSequence, userId = STATE.currentUser && STATE.currentUser.id;
  if (!id) return Promise.resolve(); state.examDetailLoading = true; state.examDetailError = ''; state.enrollmentLoading = true; refreshMonthlyView('grades');
  return api('/api/center/exams/' + encodeURIComponent(id) + '/results').then(function(data) {
    if (gradeEntryCurrent(state, userId) && sequence === state.examDetailSequence && state.selectedExamId === id) applyGradeExamDetail(state, data);
  }).catch(function(error) { if (gradeEntryCurrent(state, userId) && sequence === state.examDetailSequence && state.selectedExamId === id) { state.selectedExam = null; state.students = []; state.draft.studentId = ''; state.examDetailError = gradeExamError(error); } })
    .finally(function() { if (gradeEntryCurrent(state, userId) && sequence === state.examDetailSequence && state.selectedExamId === id) { state.examDetailLoading = false; state.enrollmentLoading = false; refreshMonthlyView('grades'); } });
}
function gradeSelectedExamResult(state) {
  var student = state.students.find(function(row) { return String(row.id) === state.draft.studentId; }); return student && student.result;
}
function saveGradeExamResult(event) {
  event.preventDefault(); var state = GRADE_ENTRY, userId = STATE.currentUser && STATE.currentUser.id, exam = state.selectedExam, studentId = Number(state.draft.studentId);
  if (state.saving || state.examsLoading || !exam || state.examDetailLoading || state.examDetailError || state.codeBusy || !studentId) return false;
  if (exam.publishedAt || gradeSelectedExamResult(state)) { state.message = exam.publishedAt ? gradeExamError({ code: 'EXAM_RESULTS_PUBLISHED' }) : gradeExamError({ code: 'RESULT_ALREADY_RECORDED' }); refreshMonthlyView('grades'); return false; }
  var raw = event.target.elements.namedItem('score').value.trim(), score = Number(raw);
  if (!raw || !Number.isFinite(score) || score < 0 || score > exam.maxScore) { state.message = 'أدخل درجة صحيحة من صفر إلى ' + exam.maxScore + '.'; refreshMonthlyView('grades'); return false; }
  var id = state.selectedExamId; state.saving = true; state.message = ''; refreshMonthlyView('grades');
  api('/api/center/exams/' + encodeURIComponent(id) + '/results', { method: 'POST', body: JSON.stringify({ studentId: studentId, score: score }) }).then(function() {
    if (!gradeEntryCurrent(state, userId) || state.selectedExamId !== id) return;
    state.message = 'حفظت النتيجة كمسودة لهذا الامتحان. لم تنشر للطالب أو ولي الأمر. ابحث عن الطالب التالي.'; state.draft.studentId = ''; state.draft.score = ''; state.studentCode = ''; state.codeMessage = ''; return loadSelectedGradeExam();
  }).catch(function(error) {
    if (!gradeEntryCurrent(state, userId) || state.selectedExamId !== id) return;
    state.message = error.code === 'RESULT_ALREADY_RECORDED' || error.code === 'EXAM_RESULTS_PUBLISHED' ? gradeExamError(error) : 'لم يتم تأكيد الحفظ. حدث نتائج الامتحان وتحقق قبل إعادة الحفظ لتجنب التكرار. ' + gradeExamError(error);
    if (error.code === 'RESULT_ALREADY_RECORDED' || error.code === 'EXAM_RESULTS_PUBLISHED') return loadSelectedGradeExam();
  }).finally(function() { state.saving = false; if (gradeEntryCurrent(state, userId)) refreshMonthlyView('grades'); }); return false;
}
function renderExamGradeEntryView(c) {
  var state = GRADE_ENTRY, exam = state.selectedExam, draft = state.draft;
  if (!state.examsLoaded && !state.examsLoading && !state.examsError) { loadGradeExams(); return; }
  var disabled = state.saving || state.examsLoading || state.examDetailLoading || !exam || !!state.examDetailError, existing = gradeSelectedExamResult(state);
  var html = gradeEntryModeHtml(state) + '<div class="monthly-hero"><h1>درجات الامتحان، طالب وراء طالب</h1><p>اختر الامتحان مرة واحدة. الاسم والمجموعة والتاريخ والدرجة العظمى من سجله، وكل نتيجة تحفظ عليه كمسودة فقط.</p></div><section class="panel"><div class="monthly-controls"><div class="field"><label for="grade-exam-month">شهر الامتحان</label><input id="grade-exam-month" type="month" value="' + safeText(state.examMonth) + '" onchange="gradeExamMonthChanged(this.value)"' + (state.saving ? ' disabled' : '') + '></div><div class="field grade-exam-choice"><label for="grade-exam-select">الامتحان غير المنشور، ضمن مجموعاتك</label><select id="grade-exam-select" onchange="selectGradeExam(this.value)"' + (state.saving || state.examsLoading ? ' disabled' : '') + '><option value="">اختر الامتحان</option>' + state.exams.map(function(row) { return '<option value="' + safeText(row.id) + '"' + (row.id === state.selectedExamId ? ' selected' : '') + '>' + safeText(row.title + ' / ' + row.subject + ' / ' + row.group + ' / ' + row.date) + '</option>'; }).join('') + '</select></div><button class="btn btn-secondary" type="button" onclick="loadGradeExams()"' + (state.saving || state.examsLoading ? ' disabled' : '') + '>تحديث الامتحانات</button>' + (state.canManageExams ? '<button class="btn btn-secondary" type="button" onclick="switchView(\'exams\')"' + (state.saving ? ' disabled' : '') + '>مواعيد الامتحانات وسجل التصحيح</button>' : '') + '</div><p class="monthly-note">حتى 200 امتحان غير منشور في الشهر المختار. تغيير الامتحان يمسح اختيار الطالب والدرجة غير المحفوظة. البحث لا ينشئ نتيجة، والنشر من صفحة الامتحانات بصلاحية مستقلة.</p>' + (state.examsLoading ? '<p role="status">جارٍ تحميل الامتحانات...</p>' : state.examsError ? '<p role="alert">' + safeText(state.examsError) + '</p>' : !state.exams.length ? '<p class="monthly-empty">لا توجد امتحانات غير منشورة في هذا الشهر ضمن نطاقك. اختر شهرا آخر أو أنشئ الامتحان من صفحة الامتحانات والنتائج أولا.</p>' : '') + '</section>';
  if (!state.selectedExamId) { c.innerHTML = html; return; }
  html += '<section class="panel"><h2 class="panel-title">إدخال نتائج ' + safeText(exam ? exam.title : 'الامتحان') + '</h2>' + (state.examDetailLoading ? '<p role="status">جارٍ تحديث طلاب ونتائج الامتحان...</p>' : '') + (state.examDetailError ? '<p role="alert">' + safeText(state.examDetailError) + '</p>' : '') + (exam && exam.publishedAt ? '<p role="alert">نشرت نتائج هذا الامتحان. الإضافة مغلقة، والتصحيح من سجل الدرجة بصلاحية مستقلة.</p>' : '') + '<form onsubmit="return saveGradeRecord(event)"><fieldset class="monthly-fieldset"' + (disabled ? ' disabled' : '') + '><div class="monthly-form-grid"><div class="field"><label for="grade-group">مجموعة الامتحان</label><input id="grade-group" value="' + safeText(exam ? exam.subject + ' / ' + exam.group + ' #' + exam.groupId : '') + '" readonly></div>' + gradeStudentCodeSearchHtml(state) + '<div class="field"><label for="grade-student">الطالب، بالاسم أو ابحث بكوده</label><select id="grade-student" required onchange="gradeStudentChanged(this.value)"' + (state.codeBusy ? ' disabled' : '') + '><option value="">اختر الطالب</option>' + state.students.map(function(student) { return '<option value="' + student.id + '"' + (String(student.id) === draft.studentId ? ' selected' : '') + '>' + safeText(student.name + ' #' + student.id + (student.result ? '، نتيجة مسجلة' : '')) + '</option>'; }).join('') + '</select></div><div class="field"><label for="grade-title">اسم الامتحان، تلقائي</label><input id="grade-title" value="' + safeText(draft.title) + '" readonly></div><div class="field"><label for="grade-assessedOn">تاريخ الامتحان، تلقائي</label><input id="grade-assessedOn" type="date" value="' + safeText(draft.assessedOn) + '" readonly></div><div class="field"><label for="grade-maxScore">الدرجة العظمى، تلقائي</label><input id="grade-maxScore" type="number" value="' + safeText(draft.maxScore) + '" readonly></div><div class="field"><label for="grade-score">درجة الطالب</label><input id="grade-score" name="score" type="number" min="0" max="' + safeText(draft.maxScore) + '" step="any" required value="' + safeText(draft.score) + '" oninput="GRADE_ENTRY.draft.score=this.value"' + (existing || (exam && exam.publishedAt) ? ' disabled' : '') + '></div></div><button class="btn" id="grade-save-button" type="submit"' + (!draft.studentId || existing || state.codeBusy || (exam && exam.publishedAt) ? ' disabled' : '') + '>حفظ نتيجة مسودة</button></fieldset></form><p id="grade-save-status" role="status" class="monthly-note">' + safeText(state.message) + '</p>';
  if (existing) html += '<div id="grade-existing-result" class="learning-day-card"><h3>لهذا الطالب نتيجة مسجلة</h3><p><strong dir="ltr">' + existing.score + ' / ' + existing.maxScore + '</strong>، مراجعة ' + existing.revision + '</p><p>لن تضاف نسخة ولن تستبدل الدرجة هنا. التصحيح بسبب موثق من سجل الدرجة في صفحة الامتحانات والنتائج.</p><button class="btn btn-secondary" type="button" onclick="switchView(\'exams\')">الامتحانات وسجل التصحيح</button></div>';
  html += '</section>';
  if (exam) html += '<section class="panel grade-record-list"><div class="monthly-controls"><h2 class="panel-title">نتائج الامتحان المختار</h2><button class="btn btn-secondary" type="button" onclick="loadSelectedGradeExam()"' + (state.saving || state.examDetailLoading ? ' disabled' : '') + '>تحديث النتائج</button></div><p class="monthly-note">' + state.students.filter(function(student) { return !!student.result; }).length + ' نتيجة مسجلة. غير المسجل ليس صفرا. ' + (exam.publishedAt ? 'النتائج منشورة.' : 'كل النتائج مسودة حتى ينشرها صاحب الصلاحية.') + '</p>' + monthlyTable(['الطالب', 'الكود', 'الدرجة', 'الحالة'], state.students.map(function(student) { return '<tr><td>' + safeText(student.name) + '</td><td><span dir="ltr">#' + student.id + '</span></td><td><span dir="ltr">' + (student.result ? student.result.score + ' / ' + student.result.maxScore : '—') + '</span></td><td>' + (student.result ? (exam.publishedAt ? 'منشورة' : 'مسودة') : 'لم تسجل نتيجة') + '</td></tr>'; }), 'لا يوجد طلاب أو نتائج متاحة ضمن نطاقك.') + '</section>';
  c.innerHTML = html;
}
