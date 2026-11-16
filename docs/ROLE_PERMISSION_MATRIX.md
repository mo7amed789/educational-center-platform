# Role and Permission Matrix

`SUPER_ADMIN` is platform-only and must never be offered by the public portal
selection screen. All backend decisions are deny-by-default.

| Capability | Super Admin | Center Owner | Center Employee | Teacher | Student | Guardian |
|---|---:|---:|---:|---:|---:|---:|
| Manage centers/platform | Yes | No | No | No | No | No |
| Manage center settings | Yes | Yes | No | No | No | No |
| View/create students | Yes | Yes | Configurable | Assigned only | Self only | Linked children only |
| Manage enrollment | Yes | Yes | Configurable | No | No | No |
| Manage teachers/groups | Yes | Yes | View by default | Assigned groups only | Assigned groups view | Children groups view |
| Record attendance | Yes | Yes | Configurable | Assigned groups only | No | No |
| Correct finalized attendance | Yes | Yes | Explicit permission | Explicit permission | No | No |
| View/manage finance | Yes | Yes | No by default | No | Configurable view | Linked children view |
| Refunds | Yes | Yes | No | No | No | No |
| Manage users/permissions | Yes | Yes | No | No | No | No |
| Audit logs/backups | Yes | Yes | No | No | No | No |

## Permission naming

Use resource/action names such as `students.view`, `students.create`,
`students.view_assigned`, `attendance.correct`, `finance.refund`,
`users.assign_permissions`, `reports.export`, and `backups.restore`.

Frontend visibility is only a usability feature. Every API route must call the
authorization service with the authenticated user, permission, resource, and
tenant/branch context.
