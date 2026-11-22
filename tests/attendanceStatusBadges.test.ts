import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const html=readFileSync('center-admin-v2.html','utf8');
const start=html.indexOf('function attendanceStatusLabel('),end=html.indexOf('function attendanceError(',start);
const context={safeText:(value:unknown)=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!))};
runInNewContext(html.slice(start,end),context);
const badge=(context as typeof context & {attendanceStatusBadge:(status:unknown,label?:string)=>string}).attendanceStatusBadge;
function luminance(hex:string){const rgb=hex.match(/\w\w/g)!.map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;}
describe('filled attendance status badges',()=>{
  it.each([['PRESENT','present','حاضر'],['ABSENT','absent','غائب'],['LATE','late','متأخر'],['EXCUSED','excused','بعذر'],['p','present','حاضر'],['a','absent','غائب'],['l','late','متأخر'],['e','excused','بعذر']])('keeps a text label as well as a distinct filled color for %s',(status,tone,label)=>{expect(badge(status)).toContain('attendance-status-'+tone);expect(badge(status)).toContain(label);});
  it('does not color missing or unknown records as absent',()=>{expect(badge(null)).toContain('attendance-status-neutral');expect(badge(null)).toContain('لم يسجل بعد');expect(badge('unexpected')).toContain('حالة غير معروفة');});
  it('escapes labels instead of treating them as HTML',()=>{expect(badge('PRESENT','<script>bad</script>')).not.toContain('<script>');});
  it.each([['087f5b','ffffff'],['be3455','ffffff'],['f6c453','271b0b'],['315da8','ffffff'],['e4e5ed','3d4158'],['494253','f5f1ff']])('keeps normal-sized text contrast above 4.5:1 for #%s on #%s',(background,foreground)=>{const a=luminance(background),b=luminance(foreground);expect((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)).toBeGreaterThanOrEqual(4.5);});
});
