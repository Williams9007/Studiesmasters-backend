import multer from "multer";
import path from "path";

// Multer setup for proof upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/proofs/"),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

router.post("/renew-payment/:studentId", upload.single("proofImage"), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { amount, packageName, grade, curriculum, subjects, studentName } = req.body;

    const subjectsArray = Array.isArray(subjects) ? subjects : JSON.parse(subjects || "[]");
    const proofPath = req.file ? `/uploads/proofs/${req.file.filename}` : "";

    const newPayment = new Payment({
      studentId,
      studentName: studentName || "N/A",
      curriculum: curriculum || "N/A",
      package: packageName || "N/A",
      grade: grade || "N/A",
      subjects: subjectsArray,
      amount,
      referenceName: `REF-${Date.now()}`,
      screenshot: proofPath,
      transactionDate: new Date(),
      status: "pending",
    });

    await newPayment.save();

    res.status(201).json({ message: "Payment submitted successfully!", payment: newPayment });
  } catch (error) {
    console.error("Error renewing payment:", error);
    res.status(500).json({ message: "Server error during payment renewal" });
  }
});
