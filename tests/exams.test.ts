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
  it('allows teachers to schedule only assigned groups without silently granting grades or publication',async()=>{expect((await create({},'teacher')).statusCode).toBe(201);expect((await create({groupId:unassigned},'teacher')).statusCode).toBe(404);const id=await make();expect((await result(id,2,pupil,'teacher')).statusCode).toBe(403);expect((await publish(id,'teacher')).statusCode).toBe(403);const body=(await request('GET','/api/center/exams?month=2026-11',undefined,'teacher')).json();expect(body.capabilities).toEqual({recordResults:false,publishResults:false});expect(body.groups.map((g:{groupId:number})=>g.groupId)).not.toContain(unassigned);});
  it('honors explicit permission denial and inactive center membership',async()=>{await prisma.userPermission.create({data:{userId:users.owner,permissionKey:'academic.manage_exams',allowed:false}});try{expect((await create()).statusCode).toBe(403);}finally{await prisma.userPermission.deleteMany({where:{userId:users.owner}});}await prisma.centerMembership.update({where:{userId_centerId:{userId:users.owner,centerId:center}},data:{active:false}});try{expect((await create()).statusCode).toBe(403);}finally{await prisma.centerMembership.update({where:{userId_centerId:{userId:users.owner,centerId:center}},data:{active:true}});}});
  it('shows schedules only for the learner current same-center enrollments',async()=>{const id=await make({title:'Own scheduled exam'});await make({title:'Unrelated scheduled exam',groupId:unassigned});const own=(await learner()).json();expect(own.examSchedule.some((e:{id:string})=>e.id===id)).toBe(true);expect(JSON.stringify(own.examSchedule)).not.toContain('Unrelated scheduled exam');expect(JSON.stringify(own)).not.toMatch(/private-phone|private-parent|private-teacher/);});
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
});
