# End-to-End Class-Group Isolation Verification (live)

**Date:** 2026-10-01 · **Scope:** two class groups of the same subject/grade/curriculum,
one student each, separate Google Meet sessions, verified against the **live**
environment (production MongoDB, `https://lms.studiesmasters.com`, the deployed
queue worker).

## Scenario seeded

| Artifact | Class 1 | Class 2 |
|---|---|---|
| Class group | `E2E-MATH1-V1` (Mathematics / GES / JHS 1) | `E2E-MATH2-V1` (Mathematics / GES / JHS 1) |
| Student | Student A (only in Class 1) | Student B (only in Class 2) |
| Sessions | 2 (Meet `e2ealpha1cls01`) | 2 (Meet `e2ebravo2cls0`) |
| Same-day pair | Class 1 @ 09:00 on D+1 | Class 2 @ 11:00 on D+1 |

Both groups map to the **same Moodle course 13** (worst case: a shared calendar).
Notifications seeded per student: own-group, global, and a deliberately
mis-targeted row (Student A's `userId` carrying Class 2's `classGroupId`).

## Results

### Backend verification — 16/16 checks

| # | Check | Result |
|---|---|---|
| B1 | Student A timetable = Class 1 only (`a1,a2`) | PASS |
| B2 | Student B timetable = Class 2 only (`b1,b2`) | PASS |
| B3 | Identical grade/curriculum/subject (`JHS 1\|GES`) but disjoint results; same-day sessions stay in their own groups | PASS |
| B4 | No Meet links in any timetable/session payload; mis-targeted group-2 notification hidden from A (and vice versa) | PASS |

Every response also advertises `assignedClassGroupIds` so a client can
re-assert the scope before rendering.

### Moodle verification — presentation layer only

* **M1/M3** The signed vclass API (the exact surface Moodle pages consume) returns
  only the caller's class group for sessions, dashboard (`assignedClassGroupIds`),
  and notifications — for both students. PASS
* **M5** Cross-group signed join returns **403** and leaks no link. PASS
* **Live SSO logins** into `lms.studiesmasters.com` succeeded for both students
  (backend-signed URL -> `303` -> `/my/`, real Moodle session, nonce consumed by the
  deployed verifier). Their Dashboard/Calendar/Month pages contained **zero**
  foreign class ids, group ids or Meet links. PASS
* The durable queue delivered all four sessions to live Moodle through the
  production worker (`syncClass` -> `succeeded`, calendar events created).

### Teacher verification — 6/6 checks

Assigned teacher sees exactly their 2 class groups / 4 sessions with both Meet
links (teacher = meeting manager); an unassigned teacher sees **none** of the
e2e classes and gets **403** on the join-link endpoint. PASS

### Security verification — 10/10 checks

| # | Attack | Result |
|---|---|---|
| S1 | A opens B's `/timetable` and `/notifications` | **403** (self-ownership guard) |
| S2 | A/B join the other group's session (JWT and signed) | **403**, no link in body |
| S3 | No token / forged token / fabricated session id | **401 / 401 / 404** |
| S4 | Tampered HMAC signature / replayed nonce | **401 / 401** |

**Harness total: 58/58 checks passed** - **Unit/contract tests: 29/29 passed**
(`tests/moodle-sync.test.js`, `tests/student-timetable-access.test.js`,
`tests/moodle/accessResolution.test.js`).


## Finding: shared-course calendar exposure (fixed)

Live evidence (`MoodleAuditLog`): all four sessions were pushed as **course
events in the same Moodle course 13** (event ids 344-365), each description
carrying its own Google Meet link - and **two real student accounts are already
enrolled in course 13**. A plain course event is visible to every enrolled
member, so Class 1's students could see Class 2's class and Meet link (and vice
versa) in Moodle's native calendar.

### Fix implemented (backend = single source of truth)

* `services/moodle/syncClass.js` - every event is now scoped to a Moodle **group**
  mirroring the class group (`idnumber sm-cg-<classGroupId>`, created on demand,
  membership synced from `MoodleLink.moodleUserId`) and published with
  `events[0][groupid]`. A course shared by several class groups can no longer
  expose another group's class or link.
* **Fail closed:** with no course mapping (`no-course-mapping`) or no group scope
  (`no-group-scope`) the class is **not published at all** - the old
  site-wide/course-wide fallbacks are gone - and a durable `syncClass` retry is
  queued. Success audits now record `moodleGroupId`.
* `services/moodle/syncTimetable.js` - same gate for student/teacher timetable
  pushes (`params: null` -> counted as failed, never an unscoped event).
* Regression coverage added in `tests/moodle-sync.test.js`
  ("calendar events are scoped to the class group's Moodle group" and
  "unscopable classes are never published (fail closed)").
* Adjacent hole found during verification and fixed: `GET /api/students/:studentId/timetable`
  and the student notification routes were unauthenticated/unauthorised - they
  now use `studentAuth` + `requireStudentSelf` (403 for any other student).

**Remediation for existing live events:** re-running a class/timetable sync after
deploy deletes the prior unscoped event (looked up from the audit trail) and
re-creates it group-scoped - e.g. `POST /api/moodle/class-sync/:sessionId` or the
admin *Sync to Moodle* action.

## Environment limitations (documented honestly)

* The local `MOODLE_WS_TOKEN` is revoked (`invalidtoken`), so `groupid`
  acceptance could not be re-probed from this machine; every push goes through
  the deployed worker's valid token. **After deploy, confirm `moodleGroupId`
  appears in new `CLASS_*` audit rows** (and that no `no-group-scope` failures
  accumulate in the sync queue).
* Moodle has no browser automation here; SSO sessions were driven over HTTP.
  Moodle's StudiesMasters display surface is the signed `/api/moodle/vclass/*`
  API (verified above); the SSO plugin itself only logs the user in.
* Login endpoints sit behind Cloudflare Turnstile (`TURNSTILE_SECRET` not set
  locally), so harness tokens were minted with the real `JWT_SECRET` in the same
  claims shape as the login handlers; an end-to-end browser login was not run.

## Cleanup

* The four test calendar events were deleted from live Moodle
  (`CLASS_CANCELLED` jobs -> worker `succeeded`, events 347/359/362/365 removed).
* Test students/teachers/class groups/sessions/notifications/jobs/MoodleLinks
  purged from MongoDB. `MoodleAuditLog` rows are retained as the audit trail.
