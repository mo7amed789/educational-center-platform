# منصة إدارة السنتر التعليمية

هذا المشروع في مرحلة التحويل من واجهة HTML محلية إلى منصة متعددة المراكز.
الملف القديم [center-admin-v2.html](./center-admin-v2.html) محفوظ كما هو
للاستخدام والرجوع إليه، ولا يُعد مصدر مصادقة أو تخزيناً مؤسسياً.

## ما تم بناؤه في الأساس الحالي

- Fastify API مكتوب بـ TypeScript.
- Prisma schema متعددة المراكز والفروع.
- جلسات Cookie من نوع `httpOnly` مع انتهاء صلاحية.
- RBAC بصلاحيات دقيقة للأدوار المطلوبة.
- حماية rate limit لمسارات المصادقة وsecurity headers.
- readiness وmetrics أساسية للتشغيل والمراقبة.
- عزل بيانات الطلاب بحسب `centerId` في API.
- استيراد آمن قابل لإعادة التشغيل لبيانات legacy: المدرسون، المجموعات، الطلاب، الحضور والمدفوعات.
- API أولي: `/healthz`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`, `/api/legacy/import`, `/api/students`.

## التشغيل المحلي

المتطلبات: Node.js 20+ وnpm.

```powershell
Copy-Item .env.example .env
npm install
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

بعد تشغيل الخادم افتح الواجهة من نفس الخادم على:

```text
http://127.0.0.1:3000/
```

لا تفتح ملف HTML مباشرة من `file://` عند اختبار تسجيل الدخول؛ تشغيله من
الخادم يضمن إرسال Cookie الجلسة إلى نفس المصدر وتجنب مشاكل CORS.

> شاشة اختيار البوابة تعرض مدير السنتر، موظف السنتر، المدرس، الطالب، وولي
> الأمر، لكنها لا تمنح صلاحيات وحدها. بعد الاختيار يجب تسجيل الدخول، والخادم
> هو الذي يحدد الدور الفعلي والصلاحيات.

حساب التطوير الذي ينشئه seed:

```text
email: owner@example.local
password: ChangeMe123!
```

غيّر كلمة المرور فوراً في أي بيئة مشتركة، ولا تستخدم حساب seed في الإنتاج.

## بيانات الاختبار

تشغيل `npm run db:seed` يضيف بيانات تجريبية قابلة لإعادة التشغيل:

- 125 طالبًا.
- 20 مدرسًا.
- 40 مجموعة على فرعين.
- 6 مقررات، سنة دراسية، و8 قاعات.
- 80 جدولًا أسبوعيًا و960 حصة فعلية بحالات scheduled/completed/active/cancelled.
- حصص `active` حالية وحصص أسبوعية ممتدة لعدة أسابيع.
- 8 أولياء أمور مع أطفال مرتبطين.
- 157 تسجيلًا في المجموعات.
- 12 يومًا من الحضور بحالات مختلفة.
- 3 أشهر من المدفوعات بحالات `paid` و`pending`.
- اشتراكات شهرية بحالات `paid` و`partial` و`pending` و`overdue`.

حسابات إضافية للتجربة:

```text
teacher1@demo.local / ChangeMe123!
student1@demo.local / ChangeMe123!
parent1@demo.local  / ChangeMe123!
```

## الاختبارات والبناء

```powershell
npm test
npm run build
```

مسارات الاختبار التشغيلية الحالية:

```text
GET  /api/center/overview
GET  /api/center/sessions?status=active
GET  /api/center/attendance
POST /api/center/attendance
GET  /api/center/subscriptions?status=overdue
POST /api/center/subscriptions
POST /api/import/excel (multipart field: file; manager permission required)
GET  /api/export/excel (manager permission required)
GET  /readyz
GET  /metrics
POST /api/auth/mfa/setup (also available from the manager UI)
POST /api/auth/mfa/enable
POST /api/auth/mfa/disable
POST /api/auth/password/change

Excel import format (`.xlsx`):

- `Students`: `id`, `name`, `phone`, `parent`, `groups` (group IDs separated by commas)
- `Teachers`: `id`, `name`, `subject`, `phone`
- `Groups`: `id`, `teacherId`, `grade`, `days`, `time`, `price`
- `Attendance`: `studentId`, `groupId`, `date`, `status`
- `Subscriptions`: `studentId`, `groupId`, `month`, `amount`, `discount`, `dueOn`, `status`

Sheet names and column names can be Arabic or English. The sheets are optional; include only the data you need to import. Legacy `.xls` files should be saved as `.xlsx` before upload.
```

## قاعدة البيانات والإنتاج

SQLite مستخدمة للتطوير المحلي فقط لتسهيل تشغيل الشريحة الأولى. قبل الإنتاج يجب
استخدام PostgreSQL عبر Prisma، تشغيل migrations versioned، إعداد `DATABASE_URL`
و`SESSION_SECRET` من secret manager، وتشغيل HTTPS ونسخ احتياطية واختبارات عزل
المراكز. لا توجد أسرار أو تكاملات مالية/رسائل خارجية مفعلة في هذا الإصدار.

## استيراد بيانات HTML القديمة

بعد تسجيل دخول مستخدم يملك `settings.manage`، أرسل JSON النسخة الاحتياطية إلى:

```http
POST /api/legacy/import
Content-Type: application/json
Cookie: center_session=<session-cookie>
```

المسار يتحقق من البنية، يحافظ على IDs والعلاقات، يستخدم upsert لإتاحة إعادة
التشغيل، ويعيد ملخصاً بالعناصر المستوردة والمتخطاة. لا يحذف HTML أو بيانات
المتصفح الأصلية.
