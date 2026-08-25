import Resource from "../models/Resource.js";
import multer from "multer";
import path from "path";

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/resources/"),
  filename: (req, file, cb) => cb(null, `resource-${Date.now()}${path.extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and Word documents are allowed"), false);
    }
  },
});

// Middleware to handle single file upload
export const uploadResourceFile = upload.single("file");

// Get all resources (Tutor Manager view)
export const getResources = async (req, res) => {
  try {
    const resources = await Resource.find()
      .populate("teacher", "fullName email curriculum")
      .populate("reviewedBy", "fullName")
      .sort({ createdAt: -1 });
    res.json({ success: true, resources });
  } catch (err) {
    console.error("❌ Failed to fetch resources:", err);
    res.status(500).json({ message: "Failed to fetch resources" });
  }
};

// Get pending resources
export const getPendingResources = async (req, res) => {
  try {
    const resources = await Resource.find({ approved: false })
      .populate("teacher", "fullName email curriculum")
      .sort({ createdAt: -1 });
    res.json({ success: true, resources });
  } catch (err) {
    console.error("❌ Failed to fetch pending resources:", err);
    res.status(500).json({ message: "Failed to fetch pending resources" });
  }
};

// Submit resource (Teacher)
export const submitResource = async (req, res) => {
  try {
    const { title, description, fileUrl, fileType, subject, curriculum, classGroupId } = req.body;
    const teacherId = req.user.id || req.user._id;

    const resource = await Resource.create({
      title,
      description,
      fileUrl,
      fileType: fileType || "pdf",
      teacher: teacherId,
      subject,
      curriculum,
      // Only set classGroup if a valid ObjectId string was provided.
      // An empty string "" would cause a Mongoose CastError on save.
      classGroup: classGroupId || undefined,
    });

    await resource.populate("teacher", "fullName email");
    res.status(201).json({ success: true, resource });
  } catch (err) {
    console.error("❌ Failed to submit resource:", err);
    // Return the actual error message in development for easier debugging
    res.status(500).json({
      message: "Failed to submit resource",
      ...(process.env.NODE_ENV === "development" && { error: err.message }),
    });
  }
};

// Approve/Reject resource with comment (Tutor Manager)
export const reviewResource = async (req, res) => {
  try {
    const { id } = req.params;
    const { approved, comment } = req.body;
    const reviewerId = req.user.id || req.user._id;

    const resource = await Resource.findById(id);
    if (!resource) return res.status(404).json({ message: "Resource not found" });

    resource.approved = approved;
    resource.comment = comment || "";
    resource.reviewedBy = reviewerId;
    resource.reviewedAt = new Date();

    await resource.save();
    await resource.populate("teacher", "fullName email");
    await resource.populate("reviewedBy", "fullName");

    res.json({ success: true, resource });
  } catch (err) {
    console.error("❌ Failed to review resource:", err);
    res.status(500).json({ message: "Failed to review resource" });
  }
};

// Get teacher's own resources
export const getMyResources = async (req, res) => {
  try {
    const teacherId = req.user.id || req.user._id;
    const resources = await Resource.find({ teacher: teacherId })
      .populate("reviewedBy", "fullName")
      .sort({ createdAt: -1 });
    res.json({ success: true, resources });
  } catch (err) {
    console.error("❌ Failed to fetch teacher resources:", err);
    res.status(500).json({ message: "Failed to fetch resources" });
  }
};
