import mongoose from "mongoose";

const QaoUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },

    email: { type: String, required: true, unique: true },

    password: { type: String, required: true }, // ✅ ADD THIS

    role: {
      type: String,
      required: true,
      default: "qao",
    },

    assignedSubjects: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Subject" },
    ],
  },
  { timestamps: true }
);

const QaoUser = mongoose.model("QaoUser", QaoUserSchema);

export default QaoUser;
