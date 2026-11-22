import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildApp } from '../src/server.js';
import { prisma } from '../src/prisma.js';

describe('unified own-child and self-only learning report', () => {
  const app = buildApp(); const pupil = 980001, otherPupil = 980002, foreignPupil = 980003, emptyPupil = 980004;
  const group = 980101, cancelled = 980102, unrelated = 980103, foreignGroup = 980104;
  let center: string, otherCenter: string; const users: Record<string,string> = {}, cookies: Record<string,string> = {}; let count = 0;
  beforeAll(async () => {
    center = (await prisma.center.create({ data: { slug: 'learning-report-a', name: 'Learning A' } })).id;
    otherCenter = (await prisma.center.create({ data: { slug: 'learning-report-b', name: 'Learning B' } })).id;
    for (const [key, role] of [['student','STUDENT'],['empty','STUDENT'],['unlinked','STUDENT'],['parent','GUARDIAN'],['otherParent','GUARDIAN'],['owner','CENTER_OWNER'],['teacher','TEACHER']] as const) {
      const user = await prisma.user.create({ data: { email: `${key}@learning-report.test`, role, centerId: center, name: key, passwordHash: 'unusable-fixture', centerMemberships: { create: { centerId: center, role } } } }); users[key] = user.id;
      const token = `learning-report-${key}`; await prisma.session.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, centerId: center, expiresAt: new Date(Date.now()+3600000) } }); cookies[key] = `center_session=${token}`;
    }
    for (const [id, centerId] of [[980201,center],[980202,otherCenter]] as const) await prisma.teacher.create({ data: { id, centerId, name:'Teacher', subject: 'رياضيات', phone:'private-contact' } });
    for (const [id,centerId,teacherId] of [[group,center,980201],[cancelled,center,980201],[unrelated,center,980201],[foreignGroup,otherCenter,980202]] as const) await prisma.group.create({ data: { id,centerId,teacherId,grade:`Class ${id}`,days:'Sunday',time:'10:00',price:100 } });
    for (const [id,centerId,userId] of [[pupil,center,users.student],[otherPupil,center,null],[foreignPupil,otherCenter,null],[emptyPupil,center,users.empty]] as const) await prisma.student.create({ data: { id,centerId,userId,name:`Pupil ${id}`,phone:'private-phone',parent:'private-parent' } });
    await prisma.enrollment.createMany({ data: [{studentId:pupil,groupId:group},{studentId:pupil,groupId:cancelled},{studentId:pupil,groupId:foreignGroup},{studentId:emptyPupil,groupId:cancelled}] });
    await prisma.guardian.create({ data: { centerId:center,userId:users.parent,name:'Parent',children:{create:[{studentId:pupil,relation:'parent'},{studentId:foreignPupil,relation:'bad-legacy-link'}]} } });
    await prisma.guardian.create({ data: { centerId:center,userId:users.otherParent,name:'Other parent',children:{create:{studentId:otherPupil,relation:'parent'}} } });
    for (const [groupId,startsAt,status] of [[group,'10:00','completed'],[group,'14:00','scheduled'],[cancelled,'11:00','cancelled'],[unrelated,'12:00','scheduled'],[foreignGroup,'13:00','scheduled']] as const) await prisma.lessonSession.create({ data: { groupId,date:'2026-11-22',startsAt,endsAt:'15:00',status,topic:'Lesson topic' } });
    await prisma.attendance.createMany({ data: [{studentId:pupil,groupId:group,date:'2026-11-22',status:'p'},{studentId:pupil,groupId:group,date:'2026-11-21',status:'LATE'},{studentId:pupil,groupId:foreignGroup,date:'2026-11-22',status:'ABSENT'}] });
    await prisma.gradeRecord.createMany({ data: [{studentId:pupil,groupId:group,title:'Zero score',assessedOn:'2026-11-20',score:0,maxScore:10,recordedById:users.owner},{studentId:pupil,groupId:group,title:'Assessment',assessedOn:'2026-11-22',score:15,maxScore:20,recordedById:users.owner},{studentId:pupil,groupId:foreignGroup,title:'Foreign private grade',assessedOn:'2026-11-22',score:10,maxScore:10,recordedById:users.owner}] });
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); });
  const get = (path: string, who='parent') => app.inject({ method:'GET',url:path,remoteAddress:`203.0.113.${++count%250+1}`,headers:{cookie:cookies[who]||''} });
  const report = (who='parent', studentId=pupil, date='2026-11-22', month='2026-11') => get(`/api/portal/${who==='parent'||who==='otherParent'?'parent':'student'}/learning-report?month=${month}&date=${date}${who==='parent'||who==='otherParent'?'&studentId='+studentId:''}`,who);
  it('gives parent and student the same real records from one read model', async () => { const parent = await report(); const self = await report('student'); expect(parent.statusCode).toBe(200); expect(self.statusCode).toBe(200); expect(parent.json()).toEqual(self.json()); });
  it('shows explicit daily status once per group without inventing per-lesson attendance', async () => {
    const body=(await report()).json(); expect(body.today).toHaveLength(2); expect(body.today.find((row:{groupId:number})=>row.groupId===group)).toMatchObject({status:'PRESENT',lessons:[{startsAt:'10:00'},{startsAt:'14:00'}]}); expect(body.today.find((row:{groupId:number})=>row.groupId===cancelled)).toMatchObject({status:null,lessons:[{status:'cancelled'}]});
  });
  it('preserves zero grades and weights subject scores by maximum marks', async () => { const body=(await report()).json(); expect(body.recentGrades.find((row:{title:string})=>row.title==='Zero score')).toMatchObject({score:0,percentage:0}); expect(body.report.subjects.find((row:{groupId:number})=>row.groupId===group)).toMatchObject({score:15,maxScore:30,percentage:50}); });
  it('lists an enrolled subject even when no attendance or grades were recorded for it', async () => { const body=(await report('empty')).json(); expect(body.report.subjects).toHaveLength(1); expect(body.report.subjects[0]).toMatchObject({groupId:cancelled,percentage:null,gradeCount:0}); expect(body.report.attendance.summary.attendanceRate).toBeNull(); });
  it('does not infer absence or a 100 percent rate from an empty day or month', async () => { const body=(await report('student',pupil,'2026-12-01','2026-12')).json(); expect(body.today).toEqual([]); expect(body.report.attendance.summary).toMatchObject({present:0,absent:0,attendanceRate:null}); });
  it('keeps the existing monthly report response compatible', async () => { const body=(await get(`/api/portal/parent/monthly-report?studentId=${pupil}&month=2026-12`)).json(); expect(body.subjects).toEqual([]); expect(body.attendance.summary.attendanceRate).toBeNull(); });
  it('excludes foreign-center enrollments, grades and attendance even through legacy bad links', async () => { const body=(await report()).json(); expect(JSON.stringify(body)).not.toMatch(/Foreign private grade|980104|private-contact|private-phone|private-parent|passwordHash|subscriptions/); });
  it.each([otherPupil,foreignPupil])('rejects an unlinked or foreign child %s', async studentId=>{ expect((await report('parent',studentId)).statusCode).toBe(404); });
  it('never lets another guardian read this child', async()=>{expect((await report('otherParent')).statusCode).toBe(404);});
  it('rejects self endpoint studentId tampering rather than selecting another pupil', async()=>{expect((await get(`/api/portal/student/learning-report?month=2026-11&date=2026-11-22&studentId=${otherPupil}`,'student')).statusCode).toBe(422);});
  it('does not return a fallback pupil when the account is not linked', async()=>{const result=await report('unlinked');expect(result.statusCode).toBe(404);expect(result.json().error).toBe('STUDENT_PROFILE_NOT_LINKED');});
  it.each(['owner','teacher'])('does not repurpose the self-only student endpoint for %s',async who=>{expect((await report(who)).statusCode).toBe(403);});
  it('does not let a student use the guardian endpoint',async()=>{expect((await get(`/api/portal/parent/learning-report?month=2026-11&date=2026-11-22&studentId=${pupil}`,'student')).statusCode).toBe(403);});
  it('requires authentication',async()=>{expect((await report('nobody')).statusCode).toBe(401);});
  it.each(['2026-02-30','2026-13-01','2026-11-22T10:00:00Z'])('rejects impossible or non-date value %s',async date=>{expect((await report('student',pupil,date)).statusCode).toBe(422);});
  it('requires a valid month and child selection',async()=>{expect((await report('parent',pupil,'2026-11-22','2026-13')).statusCode).toBe(422);expect((await get('/api/portal/parent/learning-report?month=2026-11&date=2026-11-22')).statusCode).toBe(422);});
  it.each([['student','attendance.view'],['student','academic.view'],['parent','attendance.view'],['parent','academic.view']] as const)('honors %s explicit %s denial',async(who,permissionKey)=>{await prisma.userPermission.create({data:{userId:users[who],permissionKey,allowed:false}});try{expect((await report(who)).statusCode).toBe(403);}finally{await prisma.userPermission.delete({where:{userId_permissionKey:{userId:users[who],permissionKey}}});}});
  it('honors inactive center membership',async()=>{await prisma.centerMembership.update({where:{userId_centerId:{userId:users.student,centerId:center}},data:{active:false}});try{expect((await report('student')).statusCode).toBe(403);}finally{await prisma.centerMembership.update({where:{userId_centerId:{userId:users.student,centerId:center}},data:{active:true}});}});
  it('limits recent assessments to five and excludes future-dated records',async()=>{
    await prisma.gradeRecord.createMany({data:[...Array.from({length:7},(_,i)=>({studentId:pupil,groupId:group,title:`Older ${i}`,assessedOn:`2026-10-${20+i}`,score:1,maxScore:2,recordedById:users.owner})),{studentId:pupil,groupId:group,title:'Future assessment',assessedOn:'2026-12-01',score:1,maxScore:2,recordedById:users.owner}]});
    const body=(await report()).json();expect(body.recentGrades).toHaveLength(5);expect(body.recentGrades[0].title).toBe('Assessment');expect(body.recentGrades.some((row:{title:string})=>row.title==='Future assessment')).toBe(false);expect(body.recentGrades.some((row:{title:string})=>row.title.startsWith('Older'))).toBe(true);
  });
  it('routes the student screen to self-only data without cached or fake pupils',()=>{const html=readFileSync('center-admin-v2.html','utf8');const view=html.slice(html.indexOf('function newStudentReport()'),html.indexOf('/* Monthly reporting'));expect(view).toContain('/learning-report?month=');expect(view).not.toContain('STATE.students');expect(view).not.toContain('wallet-qr');expect(view).toContain('لم يسجل الحضور بعد');expect(view).toContain('learningStateCurrent');});
});
