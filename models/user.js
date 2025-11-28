import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    role: {
      type: String,
      enum: ["student", "teacher", "admin"],
      default: "student",
    },
    phone: {
      type: String,
      required: function () {
        return this.role === "student" || this.role === "teacher";
      },
    },

    // 🔹 Student-specific fields
    curriculum: {
      type: String,
      enum: ["GES", "Cambridge"],
      required: function () {
        return this.role === "student";
      },
    },
    package: {
      type: String,
      required: function () {
        return this.role === "student";
      },
    },
    grade: {
      type: String,
      required: function () {
        return this.role === "student";
      },
    },
    subjects: {
      type: [String],
      default: [],
      validate: {
        validator: function (arr) {
          if (this.role === "student") {
            return arr.length >= 1; // require at least 1 subject
          }
          return true;
        },
        message: "Students must select at least 1 subject.",
      },
    },
    amount: {
      type: Number,
      required: function () {
        return this.role === "student";
      },
      min: [1, "Amount must be greater than 0"],
    },

    // 🔹 Teacher-specific fields
    experience: {
      type: String,
      required: function () {
        return this.role === "teacher";
      },
    },

    // 🔹 Admin-specific fields
    adminCode: {
      type: String,
      required: function () {
        return this.role === "admin";
      },
    },

    // 🔹 Password Reset Fields
    resetPasswordToken: {
      type: String,
      default: null,
    },
    resetPasswordExpires: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// ✅ Prevent OverwriteModelError (important for hot reload and re-imports)
export default mongoose.models.User || mongoose.model("User", userSchema);
