// ==========================
// INPUT VALIDATION MIDDLEWARE
// Uses Zod for schema validation
// ==========================
import { z } from "zod";

/**
 * Middleware factory: validates req.body against a Zod schema
 */
export const validate = (schema) => {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.body);
      req.body = parsed; // Replace with sanitized/coerced values
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const messages = error.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        }));
        return res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: messages,
        });
      }
      next(error);
    }
  };
};

// ==========================
// SCHEMAS
// ==========================

export const schemas = {
  // Admin login
  adminLogin: z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(1, "Password is required"),
  }),

  // Verify OTP
  verifyOtp: z.object({
    adminId: z.string().min(1, "Admin ID is required"),
    otp: z.string().length(6, "OTP must be 6 digits").regex(/^\d{6}$/, "OTP must be numeric"),
  }),

  // Create user
  createUser: z.object({
    fullName: z.string().min(1, "Full name is required").max(100),
    name: z.string().optional(),
    email: z.string().email("Invalid email address"),
    password: z.string().min(6, "Password must be at least 6 characters").optional(),
    role: z.enum(["admin", "teacher", "qao", "tutor-manager"], {
      errorMap: () => ({ message: "Role must be admin, teacher, or qao" }),
    }),
    phone: z.string().optional(),
    experience: z.string().optional(),
    curriculum: z.string().optional(),
  }),

  // Broadcast
  broadcast: z.object({
    subject: z.string().max(200).optional(),
    message: z.string().min(1, "Message is required").max(5000),
    type: z.string().optional(),
  }),

  // Broadcast to student
  broadcastStudent: z.object({
    studentId: z.string().min(1, "Student ID is required"),
    subject: z.string().max(200).optional(),
    message: z.string().min(1, "Message is required").max(5000),
  }),

  // Block IP
  blockIP: z.object({
    ip: z.string().min(1, "IP is required").max(45),
    reason: z.string().max(200).optional(),
  }),

  // Unblock IP
  unblockIP: z.object({
    ip: z.string().min(1, "IP is required").max(45),
  }),

  // Payment confirmation
  confirmPayment: z.object({
    id: z.string().optional(),
  }),

  // Class group generation
  classGroupGenerate: z.object({
    curriculum: z.string().min(1),
    grade: z.string().min(1),
    subject: z.enum(["English", "Maths", "Science"]),
    capacity: z.number().refine((n) => [1, 5, 10].includes(n), {
      message: "Capacity must be 1, 5, or 10",
    }),
    studentIds: z.array(z.string()).min(1, "At least one student is required"),
    codePrefix: z.string().min(1, "Code prefix is required").max(10),
  }),

  // Assign teacher to class group
  assignTeacher: z.object({
    teacherId: z.string().min(1, "Teacher ID is required"),
  }),
};