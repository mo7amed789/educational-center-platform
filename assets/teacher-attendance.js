// Read-only teacher attendance, separate from the staff recording controls.
function teacherAttendanceSelectionChanged() {
  var state = ATTENDANCE_PAGE; state.groupId = document.getElementById('attGroupSelect').value; state.date = document.getElementById('attDateInput').value; state.teacherSummary = null; state.key = ''; state.error = ''; return loadTeacherAttendanceSummary();
}
function loadTeacherAttendanceSummary() {
  var state = ATTENDANCE_PAGE, key = attendanceKey(), sequence = ++state.sequence, userId = STATE.currentUser && STATE.currentUser.id;
  state.loading = true; state.error = ''; state.teacherSummary = null; if (STATE.activeView === 'attendance') renderActiveView();
  return api('/api/center/attendance/teacher-summary?date=' + encodeURIComponent(state.date) + (state.groupId ? '&groupId=' + encodeURIComponent(state.groupId) : '')).then(function(data) {
    if (!attendanceCurrent(state, userId, key) || sequence !== state.sequence || STATE.currentRole !== 'TEACHER') return; state.teacherSummary = data; state.key = key;
  }).catch(function(error) { if (attendanceCurrent(state, userId, key) && sequence === state.sequence) { state.error = attendanceError(error); state.key = ''; } })
    .finally(function() { if (attendanceCurrent(state, userId, key) && sequence === state.sequence) { state.loading = false; if (STATE.activeView === 'attendance') renderActiveView(); } });
}
function renderTeacherAttendanceView(c) {
  var state = ATTENDANCE_PAGE, data = state.teacherSummary;
  if (!data && !state.loading && !state.error) { loadTeacherAttendanceSummary(); return; }
  var choices = data ? data.availableGroups : STATE.groups;
  c.innerHTML = '<div class="monthly-hero"><h1>متابعة الحضور والغياب</h1><p>للمشاهدة فقط. تسجيل الحضور والغياب مسؤولية الموظف المختص، وليس المدرس.</p></div><section class="panel"><div class="monthly-controls"><div class="field"><label for="attDateInput">يوم المتابعة</label><input id="attDateInput" type="date" min="1900-01-01" max="2199-12-31" value="' + safeText(state.date) + '" onchange="teacherAttendanceSelectionChanged()"></div><div class="field"><label for="attGroupSelect">مجموعاتك المسندة</label><select id="attGroupSelect" onchange="teacherAttendanceSelectionChanged()"><option value="">كل مجموعاتي</option>' + choices.map(function(group) { return '<option value="' + group.id + '"' + (String(group.id) === state.groupId ? ' selected' : '') + '>' + safeText(group.grade) + ' #' + group.id + '</option>'; }).join('') + '</select></div><button class="btn btn-secondary" type="button" onclick="loadTeacherAttendanceSummary()"' + (state.loading ? ' disabled' : '') + '>تحديث الإحصائيات</button></div><p class="monthly-note">الإحصائيات للمقيدين حاليا في مجموعاتك في اليوم المختار، وليست مجموع شهر أو سجل قيد تاريخي. الطالب المقيد بأكثر من مجموعة يحسب مرة لكل مجموعة. عدم التسجيل ليس غيابا.</p></section>';
  if (state.loading) { c.innerHTML += '<p class="panel" role="status">جارٍ تحميل الإحصائيات...</p>'; return; }
  if (state.error) { c.innerHTML += '<p class="panel" role="alert">' + safeText(state.error) + '</p>'; return; }
  var summary = data.summary;
  c.innerHTML += '<section class="panel"><h2 class="panel-title">ملخص ' + safeText(data.date) + '</h2><div class="learning-day-grid">' + [['total','قيد بالمجموعات'],['present','حاضر'],['absent','غائب مسجل'],['late','متأخر'],['excused','بعذر'],['unrecorded','لم يسجل بعد'],['unknown','حالة تحتاج مراجعة']].map(function(item) { return '<article class="learning-day-card" data-attendance-summary="' + item[0] + '"><p>' + item[1] + '</p><h3 dir="ltr">' + summary[item[0]] + '</h3></article>'; }).join('') + '</div></section><section class="panel grade-record-list"><h2 class="panel-title">إحصائيات كل مجموعة</h2>' + monthlyTable(['المجموعة','المقيدون','حاضر','غائب','متأخر','بعذر','لم يسجل','تحتاج مراجعة'], data.groups.map(function(group) { return monthlyCells([group.grade + ' #' + group.id,group.counts.total,group.counts.present,group.counts.absent,group.counts.late,group.counts.excused,group.counts.unrecorded,group.counts.unknown]); }), 'لا توجد مجموعات مسندة لحسابك. راجع الإدارة لربط الحساب وإسناد المجموعات.') + '</section><section class="panel grade-record-list"><h2 class="panel-title">أسماء الطلاب الغائبين</h2><p class="monthly-note">فقط الحالات المسجلة غائبا في اليوم والمجموعات المختارة. بعذر، والمتأخر، ومن لم يسجل لا يدخلون في هذه القائمة.</p>' + monthlyTable(['الطالب','الكود','المجموعة','الحالة'], data.absentees.map(function(student) { return '<tr><td>' + safeText(student.name) + '</td><td><span dir="ltr">#' + student.id + '</span></td><td>' + safeText(student.group) + ' #' + student.groupId + '</td><td>' + attendanceStatusBadge('ABSENT') + '</td></tr>'; }), 'لا توجد حالات غياب مسجلة ضمن هذا الاختيار. هذا لا يعني اكتمال تسجيل الحضور.') + '</section>';
}

function openTeacherAttendanceGroup(id) {
  ATTENDANCE_PAGE.groupId = String(id); ATTENDANCE_PAGE.teacherSummary = null; ATTENDANCE_PAGE.key = ''; ATTENDANCE_PAGE.error = ''; ATTENDANCE_PAGE.sequence++; ATTENDANCE_PAGE.loading = false; switchView('attendance');
}
