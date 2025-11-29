import mongoose from "mongoose";

const QaoUserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  role: { type: String, required: true, default: "qao" }, // added role
  assignedSubjects: [{ type: mongoose.Schema.Types.ObjectId, ref: "Subject" }],
}, { timestamps: true });

const QaoUser = mongoose.model("QaoUser", QaoUserSchema);

export default QaoUser;
