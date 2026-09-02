// services/moodle/autosync.js
//
// Mongoose change-capture plugin. When MOODLE_AUTO_SYNC=true, any change to a
// student's sync-relevant fields (email, name, curriculum, grade, package,
// subjects, subscription dates) enqueues a durable syncProfile job so Moodle is
// updated immediately — not lazily at next login.
//
// Applied in server.js only when the feature is enabled, so it is fully opt-in
// and non-breaking.

import { enqueue } from "./queue.js";

const SYNC_FIELDS = [
  "email", "fullName", "curriculum", "grade", "package", "selectedPlan",
  "subjectNames", "subjectsEnrolled", "startDate", "finishDate", "studyDuration",
];

function shouldSync(touched) {
  return SYNC_FIELDS.some((f) => touched.includes(f));
}

function queueIfNeeded(id) {
  if (!id) return;
  enqueue({
    type: "syncProfile",
    payload: { role: "student", id: String(id) },
    idempotencyKey: `sync:${String(id)}:${Date.now()}`,
  }).catch(() => {});
}

/**
 * @param {import("mongoose").Schema} schema
 */
export function studentAutosyncPlugin(schema) {
  // Doc.save() path
  schema.post("save", function (doc) {
    try {
      if (shouldSync(this.modifiedPaths())) queueIfNeeded(doc._id);
    } catch { /* ignore */ }
  });

  // findOneAndUpdate path
  schema.post("findOneAndUpdate", function (doc) {
    try {
      const update = this.getUpdate && this.getUpdate();
      const set = (update && (update.$set || update)) || {};
      const touched = Object.keys(set);
      if (shouldSync(touched)) queueIfNeeded(doc?._id);
    } catch { /* ignore */ }
  });
}

export default studentAutosyncPlugin;