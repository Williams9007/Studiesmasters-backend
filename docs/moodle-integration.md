# Moodle Integration (StudiesMasters ↔ Moodle)

StudiesMasters (Node + MongoDB) is the **single source of truth**. Moodle is
automatically mirrored via its REST Web Services. The React frontend never talks
to Moodle directly.

## Architecture

```
backend/services/moodle/
  config.js          Env-driven config (WS token, dry-run, secrets, intervals)
  curriculum.js      Canonical structure: 2 curricula x 9 grades x 3 subjects
                     = 54 courses + configurable package -> subjects map
  client.js          Moodle REST WS client (retries, transient-error handling)
  provisioning.js    Idempotent category + course provisioning, CourseMapping sync
  courseMapper.js    Subject/curriculum/grade -> Moodle course ids (CourseMapping)
  createUser/updateUser/suspendUser   Account lifecycle (backend-authoritative)
  enrollUser/unenrollUser             Enrollment + removal (idempotent)
  syncProfile.js     Full profile+enrollment sync per student
  bulkSync.js        Sync-all-students + queue snapshot
  queue.js/worker.js Mongo-backed durable queue, retry w/ backoff, dead-letter
  reconciliation.js  Periodic drift detection & repair
  metrics.js         Health + counters
  audit.js           MoodleAuditLog trail
```

## Category tree (auto-created)

```
GES        Cambridge
  Primary    Primary
  JHS        JHS
  SHS        SHS
```

Grades: Primary 4-6, JHS 1-3, SHS 1-3. Subjects: Mathematics, Science, English.
Courses: `Primary 4 Mathematics (GES)`, etc. — 54 total, one per
curriculum × grade × subject, created in the matching subcategory.

## Idempotency

- Categories/courses use deterministic `idnumber`s
  (`sm-ges`, `sm-ges-primary`, `sm-ges-primary-4-mathematics`), looked up before
  any create; existing ones are skipped — reruns never duplicate.
- CourseMapping rows are checked before Moodle is called.
- Users/enrollments go through `MoodleLink` (one link per student, keyed by
  Mongo `_id` as idnumber) and idempotency-keyed SyncJobs.

## Package mapping (no courses created)

Packages only select subjects (hence existing courses):

| Package  | Subjects                              |
| -------- | ------------------------------------- |
| Starter  | Mathematics                           |
| Standard | Mathematics, Science                  |
| Premium  | Mathematics, Science, English         |

Override at runtime via env (JSON):

```
MOODLE_PACKAGE_MAP_JSON={"Starter":["Mathematics"],"Standard":["Mathematics","Science"],"Premium":["Mathematics","Science","English"]}
```

When a student has no explicit `subjectNames`, this map is used.

## Sync triggers (automatic, no manual sync)

On student register / package purchase / curriculum change / grade change /
package change (with `MOODLE_AUTO_SYNC=true`, the autosync Mongoose plugin
enqueues durable jobs) the worker:

1. Creates the Moodle account if missing.
2. Updates name/email/etc.
3. Enrolls missing courses and **removes obsolete enrollments**.

Suspended/expired students are suspended in Moodle; nothing is ever lost —
failed jobs retry with exponential backoff and dead-letter after 5 attempts.

## Admin endpoints (all `adminAuth`-protected)

| Method | Route                              | Purpose                              |
|--------|------------------------------------|--------------------------------------|
| POST   | `/api/moodle/provision`            | Create missing categories/courses    |
| GET    | `/api/moodle/provision/status`     | Provisioned vs expected counts       |
| POST   | `/api/moodle/sync-all-users`       | Enqueue a fresh sync for every student |
| POST   | `/api/moodle/reconcile` (and `/sync/reconcile`) | Detect & repair drift   |
| GET    | `/api/moodle/course-mappings`      | List mappings                        |
| POST   | `/api/moodle/course-mappings`      | Upsert mapping                       |
| DELETE | `/api/moodle/course-mappings/:id`  | Delete mapping by id                 |
| GET    | `/api/moodle/queue`                | Pending/failed jobs + recent errors  |
| GET    | `/api/moodle/health`               | Moodle reachability + queue health   |
| GET    | `/api/moodle/audit`                | Audit log stream                     |

## Admin dashboard

Admin Dashboard → **Moodle** tab: Provision Moodle, Sync All Students,
Reconcile Enrollments, view course mappings, queue status, failed jobs, Moodle
health, synchronization status, totals (courses, categories, students synced,
pending/failed jobs, last sync) and recent errors.

## Environment variables

```
MOODLE_BASE_URL=https://moodle.example.com
MOODLE_SSO_SECRET=...            # >=16 chars, shared with the SSO plugin
MOODLE_WS_ENABLED=true           # REST web services on
MOODLE_WS_TOKEN=...              # token of a WS user with course/enrol/user caps
MOODLE_DRY_RUN=false             # true (default) = never touch a live Moodle
MOODLE_WS_RETRIES=3
MOODLE_AUTO_SYNC=true            # enqueue syncs on student changes
MOODLE_WORKER_ENABLED=true       # start the in-process queue worker
MOODLE_RECONCILIATION_ENABLED=true
MOODLE_RECONCILIATION_INTERVAL_MS=3600000
MOODLE_PACKAGE_MAP_JSON=...      # optional package -> subjects override
```

In `MOODLE_DRY_RUN=true` (default) the whole pipeline runs end-to-end against
Mongo without touching a live Moodle — provisioning, enrollments and the queue
all execute; only WS writes are simulated (no ids are persisted).

## Required Moodle setup (live mode)

1. Enable REST protocol + web services, create a WS user/token with
   `core_user_create_users`, `core_user_update_users`, `core_user_get_users_by_field`,
   `core_enrol_enrol_users`, `core_enrol_unenrol_users`,
   `core_course_get_categories`, `core_course_create_categories`,
   `core_course_get_courses`, `core_course_create_courses`.
2. Install `moodle-sso/local/studiesmasters_sso` and set the shared secret.