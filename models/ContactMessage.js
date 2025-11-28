import mongoose from "mongoose";

const contactMessageSchema = new mongoose.Schema({
  name: String,
  email: String,
  message: String,
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("ContactMessage", contactMessageSchema);
