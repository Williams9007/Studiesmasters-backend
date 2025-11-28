import Payment from "../models/Payment.js";
import Package from "../models/Package.js";

// ✅ Get latest payment for a student, include package info
export const getPaymentByStudentId = async (req, res) => {
  try {
    const studentId = req.params.id;

    // Find latest payment
    const payment = await Payment.findOne({ studentId }).sort({ createdAt: -1 });
    if (!payment) return res.status(404).json({ message: "No payment record found." });

    // Fetch the package details
    const pkg = await Package.findOne({ name: payment.package });
    
    // Calculate expiry date based on package duration
    let expiryDate = null;
    if (pkg && pkg.duration) {
      expiryDate = new Date(payment.createdAt);
      const durationDays = parseInt(pkg.duration); // store duration in days in DB
      expiryDate.setDate(expiryDate.getDate() + durationDays);
    }

    res.json({
      studentId: payment.studentId,
      packageName: payment.package,
      amount: pkg?.price || payment.amount,
      expiryDate: expiryDate || null,
      expired: expiryDate ? new Date() > expiryDate : false,
      status: payment.status,
    });
  } catch (err) {
    console.error("Error fetching student payment:", err);
    res.status(500).json({ message: "Server error." });
  }
};
