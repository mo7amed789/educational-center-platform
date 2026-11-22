import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

describe('scoped exam schedules, draft grades and explicit publication',()=>{
  const app=buildApp(), users:Record<string,string>={},cookies:Record<string,string>={};
  const group=990101,otherBranch=990102,unassigned=990103,foreign=990104,pupil=990201,otherPupil=990202,foreignPupil=990203;
  let center:string,otherCenter:string,branch:string;let counter=0;
  const input={groupId:group,title:'Unit exam',date:'2026-11-23',startsAt:'10:00',endsAt:'11:00',timezone:'Africa/Cairo',maxScore:20};
  const request=(method:'GET'|'POST',url:string,payload?:Record<string,unknown>,who='owner')=>app.inject({method,url,payload,remoteAddress:`198.51.100.${++counter%250+1}`,headers:{cookie:cookies[who]||''}});
  const create=async(data:Record<string,unknown>={},who='owner')=>request('POST','/api/center/exams',{...input,...data},who);
  const make=async(data:Record<string,unknown>={})=>{const res=await create(data);expect(res.statusCode).toBe(201);return res.json().exam.id as string;};
  const result=(id:string,score=0,studentId=pupil,who='owner')=>request('POST',`/api/center/exams/${id}/results`,{studentId,score},who);
  const publish=(id:string,who='owner')=>request('POST',`/api/center/exams/${id}/publish`,{},who);
  const learner=(who='student')=>request('GET',`/api/portal/${who==='parent'?'parent':'student'}/learning-report?month=2026-11&date=2026-11-23${who==='parent'?'&studentId='+pupil:''}`,undefined,who);
  beforeAll(async()=>{
    center=(await prisma.center.create({data:{slug:'exam-security-a',name:'Exam A'}})).id;otherCenter=(await prisma.center.create({data:{slug:'exam-security-b',name:'Exam B'}})).id;
    branch=(await prisma.branch.create({data:{centerId:center,name:'Primary'}})).id;const second=(await prisma.branch.create({data:{centerId:center,name:'Other'}})).id;
    for(const [key,role] of [['owner','CENTER_OWNER'],['branch','BRANCH_ADMIN'],['missing','BRANCH_ADMIN'],['teacher','TEACHER'],['student','STUDENT'],['parent','GUARDIAN'],['otherStudent','STUDENT']] as const){
      const user=await prisma.user.create({data:{email:`${key}@exams.test`,name:key,passwordHash:'unusable-fixture',role,centerId:center,branchId:key==='branch'?branch:null,centerMemberships:{create:{centerId:center,role}}}});users[key]=user.id;
      const token='exam-session-'+key;await prisma.session.create({data:{id:createHash('sha256').update(token).digest('hex'),userId:user.id,centerId:center,expiresAt:new Date(Date.now()+3600000)}});cookies[key]='center_session='+token;
    }
    for(const [id,centerId,userId] of [[990301,center,users.teacher],[990302,center,null],[990303,otherCenter,null]] as const)await prisma.teacher.create({data:{id,centerId,userId,name:'Teacher',subject:'Math',phone:'private-teacher'}});
    for(const [id,centerId,teacherId,branchId] of [[group,center,990301,branch],[otherBranch,center,990301,second],[unassigned,center,990302,branch],[foreign,otherCenter,990303,null]] as const)await prisma.group.create({data:{id,centerId,teacherId,branchId,grade:'Class '+id,days:'Monday',time:'10:00',price:100}});
    for(const [id,centerId,userId] of [[pupil,center,users.student],[otherPupil,center,users.otherStudent],[foreignPupil,otherCenter,null]] as const)await prisma.student.create({data:{id,centerId,userId,name:'Pupil '+id,phone:'private-phone',parent:'private-parent'}});
    await prisma.enrollment.createMany({data:[{studentId:pupil,groupId:group},{studentId:otherPupil,groupId:unassigned},{studentId:foreignPupil,groupId:group},{studentId:pupil,groupId:foreign}]});
    await prisma.guardian.create({data:{userId:users.parent,centerId:center,name:'Parent',children:{create:{studentId:pupil,relation:'parent'}}}});
  });
  afterAll(async()=>{await app.close();await prisma.$disconnect();});
  it('requires authentication',async()=>{expect((await create({},'none')).statusCode).toBe(401);});
  it.each(['student','parent'])('does not turn a %s into exam staff through custom permissions',async who=>{for(const permissionKey of ['academic.manage_exams','academic.manage_grades','academic.publish_results'])await prisma.userPermission.create({data:{userId:users[who],permissionKey,allowed:true}});try{expect((await create({},who)).statusCode).toBe(403);}finally{await prisma.userPermission.deleteMany({where:{userId:users[who]}});}});
  it.each([{date:'2026-02-30'},{date:'2026-13-01'},{startsAt:'24:00'},{startsAt:'11:00',endsAt:'10:00'},{endsAt:'10:00'},{timezone:'Cairo'},{timezone:'Invalid/Zone'},{maxScore:0},{maxScore:-1},{maxScore:1000001},{title:'  '},{centerId:'injected'}])('rejects invalid schedule %j',async data=>{expect((await create(data)).statusCode).toBe(422);});
  it('creates a schedule with an atomic audit and visible timezone',async()=>{const id=await make();expect(await prisma.auditLog.count({where:{entityId:id,action:'exams.create'}})).toBe(1);const body=(await request('GET','/api/center/exams?month=2026-11')).json();expect(body.exams.find((e:{id:string})=>e.id===id)).toMatchObject({timezone:'Africa/Cairo',maxScore:20,publishedAt:null});expect(body.capabilities).toEqual({recordResults:true,publishResults:true});});
  it('accepts UTC as an explicit zone',async()=>{expect((await create({timezone:'UTC'})).statusCode).toBe(201);});
  it('does not create exams in another center',async()=>{expect((await create({groupId:foreign})).statusCode).toBe(404);});
  it('scopes the group picker and exams to the primary branch',async()=>{const res=await request('GET','/api/center/exams?month=2026-11',undefined,'branch');expect(res.statusCode).toBe(200);expect(res.json().groups.map((g:{groupId:number})=>g.groupId).sort()).toEqual([group,unassigned]);expect((await create({groupId:otherBranch},'branch')).statusCode).toBe(404);});
  it('fails closed for a branch manager without a primary branch',async()=>{expect((await create({},'missing')).statusCode).toBe(403);});
  it('honors an explicitly inactive branch membership',async()=>{await prisma.branchMembership.create({data:{branchId:branch,userId:users.branch,active:false}});try{expect((await create({},'branch')).statusCode).toBe(403);}finally{await prisma.branchMembership.delete({where:{userId_branchId:{userId:users.branch,branchId:branch}}});}});
  it('allows teachers to schedule and grade assigned groups without granting publication',async()=>{expect((await create({},'teacher')).statusCode).toBe(201);expect((await create({groupId:unassigned},'teacher')).statusCode).toBe(404);const id=await make();expect((await result(id,2,pupil,'teacher')).statusCode).toBe(201);expect((await history(id,pupil,'teacher')).json().canCorrect).toBe(true);expect((await correct(id,{},'teacher')).statusCode).toBe(200);expect((await publish(id,'teacher')).statusCode).toBe(403);const body=(await request('GET','/api/center/exams?month=2026-11',undefined,'teacher')).json();expect(body.capabilities).toEqual({recordResults:true,publishResults:false});expect(body.groups.map((g:{groupId:number})=>g.groupId)).not.toContain(unassigned);});
  it('honors explicit permission denial and inactive center membership',async()=>{await prisma.userPermission.create({data:{userId:users.owner,permissionKey:'academic.manage_exams',allowed:false}});try{expect((await create()).statusCode).toBe(403);}finally{await prisma.userPermission.deleteMany({where:{userId:users.owner}});}await prisma.centerMembership.update({where:{userId_centerId:{userId:users.owner,centerId:center}},data:{active:false}});try{expect((await create()).statusCode).toBe(403);}finally{await prisma.centerMembership.update({where:{userId_centerId:{userId:users.owner,centerId:center}},data:{active:true}});}});
  it('shows schedules only for the learner current same-center enrollments',async()=>{const id=await make({title:'Own scheduled exam'});await make({title:'Unrelated scheduled exam',groupId:unassigned});const own=(await learner()).json();expect(own.examSchedule.some((e:{id:string})=>e.id===id)).toBe(true);expect(JSON.stringify(own.examSchedule)).not.toContain('Unrelated scheduled exam');expect(JSON.stringify(own)).not.toMatch(/private-phone|private-parent|private-teacher/);});
  it('offers only unpublished, selected-month exams in the grade-authorized teacher scope', async () => {
    const own = await make({ title: 'Grade picker own exam' });
    const unrelated = await make({ title: 'Grade picker unrelated', groupId: unassigned });
    const nextMonth = await make({ title: 'Grade picker next month', date: '2026-12-01' });
    const published = await make({ title: 'Grade picker published' }); await prisma.exam.update({ where: { id: published }, data: { publishedAt: new Date() } });
    const res = await request('GET', '/api/center/grades/exams?month=2026-11', undefined, 'teacher'); expect(res.statusCode).toBe(200);
    const body = res.json(); expect(body.limit).toBe(200); expect(body.exams.find((exam: { id: string }) => exam.id === own)).toMatchObject({ title: 'Grade picker own exam', groupId: group, date: '2026-11-23', maxScore: 20 });
    expect(body.exams.map((exam: { id: string }) => exam.id)).not.toEqual(expect.arrayContaining([unrelated, nextMonth, published]));
    for (const id of [unrelated, nextMonth, published]) expect(body.exams.some((exam: { id: string }) => exam.id === id)).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/private-phone|private-parent|private-teacher/);
  });
  it('lets grade-only teachers choose existing exams without scheduling permission', async () => {
    await prisma.userPermission.create({ data: { userId: users.teacher, permissionKey: 'academic.manage_exams', allowed: false } });
    try { expect((await request('GET', '/api/center/exams?month=2026-11', undefined, 'teacher')).statusCode).toBe(403); const res = await request('GET', '/api/center/grades/exams?month=2026-11', undefined, 'teacher'); expect(res.statusCode).toBe(200); expect(res.json().canManageExams).toBe(false); expect(res.json().exams.length).toBeGreaterThan(0); }
    finally { await prisma.userPermission.deleteMany({ where: { userId: users.teacher } }); }
  });
  it('denies the exam grading picker without grade permission even when scheduling is allowed', async () => {
    await prisma.userPermission.create({ data: { userId: users.teacher, permissionKey: 'academic.manage_grades', allowed: false } });
    try { expect((await request('GET', '/api/center/grades/exams?month=2026-11', undefined, 'teacher')).statusCode).toBe(403); }
    finally { await prisma.userPermission.deleteMany({ where: { userId: users.teacher } }); }
  });
  it.each(['none', 'student', 'parent'])('keeps %s out of the grading exam picker', async who => {
    if (who !== 'none') await prisma.userPermission.create({ data: { userId: users[who], permissionKey: 'academic.manage_grades', allowed: true } });
    try { expect((await request('GET', '/api/center/grades/exams?month=2026-11', undefined, who)).statusCode).toBe(who === 'none' ? 401 : 403); }
    finally { if (who !== 'none') await prisma.userPermission.deleteMany({ where: { userId: users[who] } }); }
  });
  it('validates grading-picker month and rejects client scope parameters', async () => {
    for (const query of ['', '?month=2026-13', '?month=2026-11&groupId=' + unassigned]) expect((await request('GET', '/api/center/grades/exams' + query)).statusCode).toBe(422);
    const res = await request('GET', '/api/center/grades/exams?month=2026-11', undefined, 'branch'); expect(res.statusCode).toBe(200); expect(res.json().exams.every((exam: { groupId: number }) => [group, unassigned].includes(exam.groupId))).toBe(true);
  });
  it('rejects an unrecorded publication',async()=>{expect((await publish(await make())).statusCode).toBe(422);});
  it('validates score maximum and actual enrollment, including corrupt foreign enrollment',async()=>{const id=await make();expect((await result(id,21)).statusCode).toBe(422);expect((await result(id,-1)).statusCode).toBe(422);expect((await result(id,2,otherPupil)).statusCode).toBe(404);expect((await result(id,2,foreignPupil)).statusCode).toBe(404);});
  it('records zero, keeps drafts hidden everywhere, then publishes the same own-only grade',async()=>{
    const id=await make({title:'Zero exam result'});expect((await result(id)).statusCode).toBe(201);expect((await result(id,1)).statusCode).toBe(409);
    const draft=(await learner()).json();expect(draft.examResults).toEqual([]);expect(JSON.stringify(draft.report.grades)).not.toContain('Zero exam result');expect(JSON.stringify(draft.recentGrades)).not.toContain('Zero exam result');expect(JSON.stringify((await request('GET','/api/center/grades?month=2026-11')).json())).not.toContain('Zero exam result');
    expect((await publish(id)).statusCode).toBe(200);const own=(await learner()).json();expect(own.examResults.find((g:{examId:string})=>g.examId===id)).toMatchObject({score:0,maxScore:20});expect(own.recentGrades.find((g:{title:string})=>g.title==='Zero exam result')).toMatchObject({score:0,percentage:0});expect(own).toEqual((await learner('parent')).json());expect(JSON.stringify((await learner('otherStudent')).json())).not.toContain('Zero exam result');
    expect((await publish(id)).json().repeated).toBe(true);expect(await prisma.auditLog.count({where:{entityId:id,action:'exams.publish'}})).toBe(1);expect((await result(id,2)).statusCode).toBe(409);
  });
  it('excludes corrupt exam/group references and preserves own historical results after unenrollment',async()=>{
    const id=await make({title:'Historical published exam'});expect((await result(id,3)).statusCode).toBe(201);expect((await publish(id)).statusCode).toBe(200);
    await prisma.gradeRecord.create({data:{examId:id,studentId:otherPupil,groupId:unassigned,title:'Corrupt unrelated result',assessedOn:'2026-11-23',score:2,maxScore:20,recordedById:users.owner}});
    expect(JSON.stringify((await learner('otherStudent')).json())).not.toContain('Corrupt unrelated result');
    await prisma.enrollment.delete({where:{studentId_groupId:{studentId:pupil,groupId:group}}});
    try{const body=(await learner()).json();expect(body.examSchedule.some((exam:{id:string})=>exam.id===id)).toBe(false);expect(body.examResults.some((exam:{examId:string})=>exam.examId===id)).toBe(true);const roster=(await request('GET',`/api/center/exams/${id}/results`)).json();expect(roster.students.some((student:{id:number})=>student.id===pupil)).toBe(true);}finally{await prisma.enrollment.create({data:{studentId:pupil,groupId:group}});}
  });
  it('does not accept client-supplied result title, group or maximum',async()=>{const id=await make();expect((await request('POST',`/api/center/exams/${id}/results`,{studentId:pupil,score:1,maxScore:100,groupId:unassigned,title:'Injected'})).statusCode).toBe(422);});
  it.each(['exams.create','exams.result','exams.publish'])('rolls back the change if audit writing fails for %s',async action=>{
    const id=await make({title:'Atomic exam'});if(action==='exams.publish')expect((await result(id,2)).statusCode).toBe(201);const before=await prisma.exam.count();
    await prisma.$executeRawUnsafe("CREATE TRIGGER exam_audit_failure BEFORE INSERT ON AuditLog WHEN NEW.action = '"+action+"' BEGIN SELECT RAISE(FAIL, 'exam audit failure'); END");
    try{const res=action==='exams.create'?await create({title:'Must roll back'}):action==='exams.result'?await result(id,2):await publish(id);expect(res.statusCode).toBe(500);if(action==='exams.create')expect(await prisma.exam.count()).toBe(before);else if(action==='exams.result')expect(await prisma.gradeRecord.count({where:{examId:id}})).toBe(0);else expect((await prisma.exam.findUniqueOrThrow({where:{id}})).publishedAt).toBeNull();}finally{await prisma.$executeRawUnsafe('DROP TRIGGER exam_audit_failure');}
  });

  const history=(id:string,studentId=pupil,who='owner')=>request('GET',`/api/center/exams/${id}/results/${studentId}/history`,undefined,who);
  const correct=(id:string,data:Record<string,unknown>={},who='owner',studentId=pupil)=>request('POST',`/api/center/exams/${id}/results/${studentId}/corrections`,{score:7,expectedRevision:0,reason:'Corrected marking error',...data},who);
  const recorded=async(score=2)=>{const id=await make();expect((await result(id,score)).statusCode).toBe(201);return id;};
  it('corrects a draft to zero with a revision, previous score, reason, actor and atomic audit',async()=>{
    const id=await recorded();expect((await correct(id,{score:0})).json()).toMatchObject({grade:{score:0,maxScore:20,revision:1},published:false});
    const data=(await history(id)).json();expect(data.grade).toMatchObject({score:0,revision:1});expect(data.history).toHaveLength(1);expect(data.history[0]).toMatchObject({previousScore:2,score:0,maxScore:20,revision:1,reason:'Corrected marking error',correctedBy:'owner'});
    expect(await prisma.auditLog.count({where:{action:'exams.correct_result',entityId:data.grade.id}})).toBe(1);expect((await learner()).json().examResults.some((g:{examId:string})=>g.examId===id)).toBe(false);
  });
  it.each([{score:-1},{score:21},{score:2},{reason:'tiny'},{reason:' '},{reason:'x'.repeat(501)},{expectedRevision:-1},{expectedRevision:0.5},{maxScore:200},{confirmPublished:'true'}])('rejects invalid correction or no-op %j without history',async data=>{const id=await recorded();expect((await correct(id,data)).statusCode).toBe(422);expect((await history(id)).json().history).toEqual([]);expect((await history(id)).json().grade.score).toBe(2);});
  it('rejects stale revisions and retains the newer score',async()=>{const id=await recorded();expect((await correct(id)).statusCode).toBe(200);const stale=await correct(id,{score:9});expect(stale.statusCode).toBe(409);expect(stale.json().error).toBe('GRADE_CHANGED');expect((await history(id)).json().grade).toMatchObject({score:7,revision:1});expect((await history(id)).json().history).toHaveLength(1);});
  it('requires explicit confirmation and both permissions to correct a published result',async()=>{
    const id=await recorded();await publish(id);expect((await correct(id)).json().error).toBe('PUBLISHED_CORRECTION_CONFIRMATION_REQUIRED');
    await prisma.userPermission.create({data:{userId:users.teacher,permissionKey:'academic.manage_grades',allowed:true}});
    try{expect((await history(id,pupil,'teacher')).json().canCorrect).toBe(false);expect((await correct(id,{confirmPublished:true},'teacher')).statusCode).toBe(403);}finally{await prisma.userPermission.deleteMany({where:{userId:users.teacher}});}
    expect((await correct(id,{confirmPublished:true})).statusCode).toBe(200);
    for(const who of ['student','parent']){const body=(await learner(who)).json();expect(body.examResults.find((g:{examId:string})=>g.examId===id)).toMatchObject({score:7,revision:1});expect(JSON.stringify(body)).not.toContain('Corrected marking error');expect(JSON.stringify(body)).not.toContain('correctedBy');}
    expect((await learner('otherStudent')).json().examResults.some((g:{examId:string})=>g.examId===id)).toBe(false);
  });
  it.each(['student','parent','none'])('does not allow %s into staff correction history or writes',async who=>{const id=await recorded();expect((await history(id,pupil,who)).statusCode).toBe(who==='none'?401:403);expect((await correct(id,{},who)).statusCode).toBe(who==='none'?401:403);});
  it('scopes teacher and primary-branch correction access',async()=>{
    const id=await recorded();await prisma.userPermission.create({data:{userId:users.teacher,permissionKey:'academic.manage_grades',allowed:true}});
    try{expect((await correct(id,{},'teacher')).statusCode).toBe(200);const other=await make({groupId:unassigned});await result(other,2,otherPupil);expect((await history(other,otherPupil,'teacher')).statusCode).toBe(404);expect((await correct(other,{},'teacher',otherPupil)).statusCode).toBe(404);}finally{await prisma.userPermission.deleteMany({where:{userId:users.teacher}});}
    const other=await make({groupId:otherBranch});await prisma.enrollment.create({data:{groupId:otherBranch,studentId:pupil}});try{await result(other,2);expect((await history(other,pupil,'branch')).statusCode).toBe(404);expect((await correct(other,{},'branch')).statusCode).toBe(404);}finally{await prisma.enrollment.delete({where:{studentId_groupId:{studentId:pupil,groupId:otherBranch}}});}
  });
  it('rejects unrelated, missing and foreign result identifiers',async()=>{const id=await recorded();for(const studentId of [otherPupil,foreignPupil,2147483600]){expect((await history(id,studentId)).statusCode).toBe(404);expect((await correct(id,{},'owner',studentId)).statusCode).toBe(404);}expect((await history('missing-exam')).statusCode).toBe(404);});
  it('retains correction access to an existing own-group result after unenrollment',async()=>{const id=await recorded();await prisma.enrollment.delete({where:{studentId_groupId:{studentId:pupil,groupId:group}}});try{expect((await correct(id)).statusCode).toBe(200);}finally{await prisma.enrollment.create({data:{studentId:pupil,groupId:group}});}});
  it('rolls back both score and history if audit writing fails',async()=>{
    const id=await recorded();await prisma.$executeRawUnsafe("CREATE TRIGGER correction_audit_failure BEFORE INSERT ON AuditLog WHEN NEW.action = 'exams.correct_result' BEGIN SELECT RAISE(FAIL, 'correction audit failure'); END");
    try{expect((await correct(id)).statusCode).toBe(500);const data=(await history(id)).json();expect(data.grade).toMatchObject({score:2,revision:0});expect(data.history).toEqual([]);}finally{await prisma.$executeRawUnsafe('DROP TRIGGER correction_audit_failure');}
  });
  it('rejects hard deletion without removing a student or enrollment with correction history',async()=>{const id=await recorded();await correct(id);const res=await app.inject({method:'DELETE',url:'/api/students/'+pupil,remoteAddress:'198.51.100.254',headers:{cookie:cookies.owner}});expect(res.statusCode).toBe(409);expect(res.json().error).toBe('STUDENT_HAS_GRADE_HISTORY');expect(await prisma.student.findUnique({where:{id:pupil}})).not.toBeNull();expect(await prisma.enrollment.count({where:{studentId:pupil,groupId:group}})).toBe(1);});
  it('returns the latest 50 revisions while retaining all immutable history rows',async()=>{
    const id=await recorded(),grade=await prisma.gradeRecord.findFirstOrThrow({where:{examId:id}});
    await prisma.gradeCorrection.createMany({data:Array.from({length:55},(_,i)=>({gradeRecordId:grade.id,revision:i+1,previousScore:1,score:2,maxScore:20,reason:'Historical correction fixture',correctedById:users.owner}))});
    const data=(await history(id)).json();expect(data.limit).toBe(50);expect(data.history).toHaveLength(50);expect(data.history[0].revision).toBe(55);expect(data.history[49].revision).toBe(6);expect(await prisma.gradeCorrection.count({where:{gradeRecordId:grade.id}})).toBe(55);
  });


  const notifications=(who='student')=>request('GET','/api/portal/notifications',undefined,who);
  const markRead=(id:string,who='student')=>request('POST',`/api/portal/notifications/${id}/read`,{},who);
  it('creates no notifications for schedules, draft results or draft corrections',async()=>{const id=await recorded();await correct(id);expect(await prisma.learnerNotification.count({where:{gradeRecord:{examId:id}}})).toBe(0);});
  it('atomically publishes one private notification per eligible student/guardian and never duplicates on repeat',async()=>{
    const id=await recorded();expect((await publish(id)).statusCode).toBe(200);expect((await publish(id)).statusCode).toBe(200);
    const rows=await prisma.learnerNotification.findMany({where:{gradeRecord:{examId:id}}});expect(rows).toHaveLength(2);expect(rows.map(r=>r.recipientUserId).sort()).toEqual([users.student,users.parent].sort());expect(rows.every(r=>r.kind==='RESULT_PUBLISHED'&&r.revision===0)).toBe(true);
    const own=(await notifications()).json().items.find((r:{id:string})=>r.id===rows.find(r=>r.recipientUserId===users.student)!.id);expect(own).toMatchObject({studentId:pupil,kind:'RESULT_PUBLISHED',revision:0,readAt:null});expect(JSON.stringify(own)).not.toMatch(/reason|correctedBy|private-phone|private-parent|passwordHash/);expect((await notifications('otherStudent')).json().items.some((r:{id:string})=>rows.some(n=>n.id===r.id))).toBe(false);
  });
  it('adds a revision-specific notification for a published correction without the private reason',async()=>{
    const id=await recorded();await publish(id);expect((await correct(id,{confirmPublished:true})).statusCode).toBe(200);
    const rows=await prisma.learnerNotification.findMany({where:{gradeRecord:{examId:id}},orderBy:{revision:'asc'}});expect(rows).toHaveLength(4);expect(rows.filter(r=>r.kind==='RESULT_CORRECTED').every(r=>r.revision===1)).toBe(true);expect(JSON.stringify((await notifications()).json())).not.toContain('Corrected marking error');
  });
  it('marks only this recipient receipt, preserves the first read timestamp, and is idempotent',async()=>{
    const id=await recorded();await publish(id);const row=await prisma.learnerNotification.findFirstOrThrow({where:{recipientUserId:users.student,gradeRecord:{examId:id}}});
    expect((await markRead(row.id,'parent')).statusCode).toBe(404);expect((await markRead(row.id,'otherStudent')).statusCode).toBe(404);expect((await markRead(row.id)).statusCode).toBe(200);const first=(await prisma.learnerNotification.findUniqueOrThrow({where:{id:row.id}})).readAt;expect(first).not.toBeNull();expect((await markRead(row.id)).statusCode).toBe(200);expect((await prisma.learnerNotification.findUniqueOrThrow({where:{id:row.id}})).readAt).toEqual(first);expect(await prisma.learnerNotification.count({where:{recipientUserId:users.parent,gradeRecord:{examId:id},readAt:null}})).toBe(1);
  });
  it.each(['owner','teacher','none'])('does not give %s access to learner notification inboxes',async who=>{expect((await notifications(who)).statusCode).toBe(who==='none'?401:403);expect((await markRead('missing-notification',who)).statusCode).toBe(who==='none'?401:403);});
  it('rechecks guardian linkage on both reads and mark-read, rather than trusting stored delivery',async()=>{
    const id=await recorded();await publish(id);const row=await prisma.learnerNotification.findFirstOrThrow({where:{recipientUserId:users.parent,gradeRecord:{examId:id}}}),guardian=await prisma.guardian.findUniqueOrThrow({where:{userId:users.parent}});
    await prisma.studentGuardian.deleteMany({where:{guardianId:guardian.id,studentId:pupil}});
    try{expect((await notifications('parent')).json().items).toEqual([]);expect((await markRead(row.id,'parent')).statusCode).toBe(404);}finally{await prisma.studentGuardian.create({data:{guardianId:guardian.id,studentId:pupil,relation:'parent'}});}
  });
  it('rechecks current student-account binding instead of trusting stored delivery',async()=>{const id=await recorded();await publish(id);const row=await prisma.learnerNotification.findFirstOrThrow({where:{recipientUserId:users.student,gradeRecord:{examId:id}}});await prisma.student.update({where:{id:pupil},data:{userId:null}});try{expect((await notifications()).json().items).toEqual([]);expect((await markRead(row.id)).statusCode).toBe(404);}finally{await prisma.student.update({where:{id:pupil},data:{userId:users.student}});}});
  it('hides stored notifications if the student changes center',async()=>{const id=await recorded();await publish(id);await prisma.student.update({where:{id:pupil},data:{centerId:otherCenter}});try{expect((await notifications()).json().items).toEqual([]);expect((await notifications('parent')).json().items).toEqual([]);}finally{await prisma.student.update({where:{id:pupil},data:{centerId:center}});}});
  it('fails closed for a corrupt grade/exam group reference',async()=>{const id=await recorded();await publish(id);const grade=await prisma.gradeRecord.findFirstOrThrow({where:{examId:id}}),row=await prisma.learnerNotification.findFirstOrThrow({where:{gradeRecordId:grade.id,recipientUserId:users.student}});await prisma.gradeRecord.update({where:{id:grade.id},data:{groupId:unassigned}});try{expect((await notifications()).json().items.some((n:{id:string})=>n.id===row.id)).toBe(false);expect((await markRead(row.id)).statusCode).toBe(404);}finally{await prisma.gradeRecord.update({where:{id:grade.id},data:{groupId:group}});}});
  it('honors current academic permission denial and inactive membership',async()=>{
    await prisma.userPermission.create({data:{userId:users.student,permissionKey:'academic.view',allowed:false}});try{expect((await notifications()).statusCode).toBe(403);expect((await markRead('missing')).statusCode).toBe(403);}finally{await prisma.userPermission.deleteMany({where:{userId:users.student}});}
    await prisma.centerMembership.update({where:{userId_centerId:{userId:users.student,centerId:center}},data:{active:false}});try{expect((await notifications()).statusCode).toBe(403);}finally{await prisma.centerMembership.update({where:{userId_centerId:{userId:users.student,centerId:center}},data:{active:true}});}
  });
  it('never creates a new notification for an inactive student account or foreign guardian profile',async()=>{const id=await recorded(),guardian=await prisma.guardian.findUniqueOrThrow({where:{userId:users.parent}});await prisma.user.update({where:{id:users.student},data:{active:false}});await prisma.guardian.update({where:{id:guardian.id},data:{centerId:otherCenter}});try{await publish(id);expect(await prisma.learnerNotification.count({where:{gradeRecord:{examId:id}}})).toBe(0);}finally{await prisma.user.update({where:{id:users.student},data:{active:true}});await prisma.guardian.update({where:{id:guardian.id},data:{centerId:center}});}});
  it.each(['publication','correction'])('rolls back %s and its audit/history if notification writing fails',async kind=>{
    const id=await recorded();if(kind==='correction')await publish(id);const before=await prisma.learnerNotification.count({where:{gradeRecord:{examId:id}}});
    await prisma.$executeRawUnsafe("CREATE TRIGGER learner_notification_failure BEFORE INSERT ON LearnerNotification BEGIN SELECT RAISE(FAIL, 'notification failure'); END");
    try{const res=kind==='publication'?await publish(id):await correct(id,{confirmPublished:true});expect(res.statusCode).toBe(500);expect(await prisma.learnerNotification.count({where:{gradeRecord:{examId:id}}})).toBe(before);if(kind==='publication'){expect((await prisma.exam.findUniqueOrThrow({where:{id}})).publishedAt).toBeNull();expect(await prisma.auditLog.count({where:{entityId:id,action:'exams.publish'}})).toBe(0);}else{const data=(await history(id)).json();expect(data.grade).toMatchObject({score:2,revision:0});expect(data.history).toEqual([]);expect(await prisma.auditLog.count({where:{entityId:data.grade.id,action:'exams.correct_result'}})).toBe(0);}}finally{await prisma.$executeRawUnsafe('DROP TRIGGER learner_notification_failure');}
  });
  it('keeps selected-child filtering scoped and reports only an explicit latest-50 unread window',async()=>{
    const id=await recorded();await publish(id);const grade=await prisma.gradeRecord.findFirstOrThrow({where:{examId:id}});await prisma.learnerNotification.createMany({data:Array.from({length:60},(_,i)=>({recipientUserId:users.student,gradeRecordId:grade.id,eventKey:'window-fixture:'+i,kind:'RESULT_CORRECTED',revision:i+1}))});
    const data=(await notifications()).json();expect(data.items).toHaveLength(50);expect(data.limit).toBe(50);expect(data.unreadInPage).toBe(data.items.filter((n:{readAt:string|null})=>!n.readAt).length);expect((await request('GET','/api/portal/notifications?studentId='+otherPupil,undefined,'parent')).json().items).toEqual([]);expect((await request('GET','/api/portal/notifications?recipientUserId='+users.student,undefined,'parent')).statusCode).toBe(422);
  });

});
