// src/models/Teacher.js
import mongoose from "mongoose";


const teacherSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true },
});
export default mongoose.models.Teacher || mongoose.model("Teacher", teacherSchema);