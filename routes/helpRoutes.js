import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  try {
    const helpContent = `
      Welcome to EduConnect Help Center!
      - For password issues, contact support@educonnect.com.
      - For account-related queries, visit your profile settings.
    `;
    res.json({ content: helpContent });
  } catch (err) {
    console.error("Error fetching help content:", err);
    res.status(500).json({ message: "Failed to fetch help content." });
  }
});

export default router;