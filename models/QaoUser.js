// backend/models/QaoUser.js
import mongoose from "mongoose";

const QaoUserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  assignedSubjects: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
  // You can add more fields like role, password, etc.
}, { timestamps: true });

const QaoUser = mongoose.model("QaoUser", QaoUserSchema);

export default QaoUser;
