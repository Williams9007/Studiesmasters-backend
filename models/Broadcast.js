import mongoose from "mongoose";

const broadcastSchema = new mongoose.Schema(
  {
    // sender is now polymorphic via senderModel. Existing documents keep
    // working because senderModel defaults to "Admin" (the historical value).
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "senderModel",
    },
    senderModel: {
      type: String,
      enum: ["Admin", "Teacher", "QaoUser"],
      default: "Admin",
    },

    // Teacher-originated broadcasts use these fields; admin broadcasts continue
    // to use `sender`, `type`, and `recipients` above.
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Teacher",
    },

    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
    },

    type: {
      type: String,
      enum: ["students", "teachers", "qaos", "tutormanagers", "all", "single"],
      default: "all",
    },

    recipients: [
      {
        type: mongoose.Schema.Types.ObjectId,
        refPath: "recipientModel",
      },
    ],

    recipientModel: {
      type: String,
      enum: ["Student", "Teacher", "QaoUser"],
    },

    subject: {
      type: String,
    },

    message: {
      type: String,
      required: true,
    },

    recipientsCount: {
      type: Number,
      default: 0,
    },

    link: { type: String, trim: true, default: null },
    attachment: { type: String, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("Broadcast", broadcastSchema);
