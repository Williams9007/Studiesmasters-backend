// models/index.js — pure re-export barrel (no schema lives here).
// NOTE: this file previously re-declared the Student schema without the
// `mongoose.models.X ||` guard, which throws OverwriteModelError in dev
// when Student.js is also imported. Import the canonical model instead.
import Student from "./Student.js";

export { Student };
export default Student;
