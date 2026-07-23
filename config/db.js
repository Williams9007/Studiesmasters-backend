import mongoose from "mongoose";

const connectDB = async () => {
  try {
    const required = ["MONGO_USER", "MONGO_PASSWORD", "MONGO_HOST", "MONGO_DB_NAME"];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length) {
      console.error(`❌ Missing MongoDB env variables: ${missing.join(", ")}`);
      process.exit(1);
    }

    const MONGO_URI = `mongodb+srv://${encodeURIComponent(process.env.MONGO_USER)}:${encodeURIComponent(process.env.MONGO_PASSWORD)}@${process.env.MONGO_HOST}/${encodeURIComponent(process.env.MONGO_DB_NAME)}`;

    const conn = await mongoose.connect(MONGO_URI);
    console.log("✅ MongoDB connected:", conn.connection.host);
    console.log("📘 Using database:", conn.connection.name);
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
    process.exit(1);
  }
};

export default connectDB;
