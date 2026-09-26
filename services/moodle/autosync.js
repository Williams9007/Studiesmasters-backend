// services/moodle/autosync.js
//
// Mongoose change-capture plugin. When MOODLE_AUTO_SYNC=true, any change to a
// student's sync-relevant fields (email, name, curriculum, grade, package,
// subjects, subscription dates) enqueues a durable syncProfile job so Moodle is
// updated immediately — not lazily at next login.
//
// Applied in server.js only when the feature is enabled, so it is fully opt-in
// and non-breaking.

import { enqueueCoalesced } from "./queue.js";

const SYNC_FIELDS = [
  "email", "fullName", "curriculum", "grade", "package", "selectedPlan",
  "subjectNames", "subjectsEnrolled", "startDate", "finishDate", "studyDuration",
];

export function shouldSync(touched = []) {
  return SYNC_FIELDS.some((field) => touched.some((key) => key === field || key.startsWith(`${field}.`)));
}

export function touchedFields(update = {}) {
  const fields = new Set();
  for (const [operator, value] of Object.entries(update || {})) {
    if (operator === "$set" || operator === "$addToSet" || operator === "$pull") {
      for (const key of Object.keys(value || {})) fields.add(key);
    } else if (operator === "$unset") {
      for (const key of Object.keys(value || {})) fields.add(key);
    } else if (!operator.startsWith("$")) {
      fields.add(operator);
    }
  }
  return [...fields];
}

export function queueStudentSync(id) {
  if (!id) return Promise.resolve();
  return enqueueCoalesced({
    type: "syncProfile",
    payload: { role: "student", id: String(id) },
    idempotencyKey: `syncProfile:student:${String(id)}`,
  });
}

/**
 * @param {import("mongoose").Schema} schema
 */
export function studentAutosyncPlugin(schema) {
  const queueSafely = (id) => { if (id) queueStudentSync(id).catch(() => {}); };
  const handleUpdate = async function (result) {
    try {
      if (!shouldSync(touchedFields(this.getUpdate?.()))) return;
      const id = result?._id;
      if (id) { queueSafely(id); return; }
      const affected = await this.model.findOne(this.getFilter?.() || {}).select("_id").lean();
      queueSafely(affected?._id);
    } catch { /* autosync must never break the website write */ }
  };

  schema.post("save", function (doc) {
    if (shouldSync(this.modifiedPaths())) queueSafely(doc?._id);
  });
  schema.post("findOneAndUpdate", handleUpdate);
  schema.post("findByIdAndUpdate", handleUpdate);
  schema.post("updateOne", handleUpdate);
  schema.post("updateMany", async function () {
    try {
      if (!shouldSync(touchedFields(this.getUpdate?.()))) return;
      const ids = await this.model.distinct("_id", this.getFilter?.() || {});
      ids.forEach(queueSafely);
    } catch { /* ignore */ }
  });
  schema.post("insertMany", function (docs) {
    if (Array.isArray(docs)) docs.forEach((doc) => queueSafely(doc?._id));
  });
}

export default studentAutosyncPlugin;