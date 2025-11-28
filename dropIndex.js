import mongoose from "mongoose";

const MONGO_URI = "mongodb://127.0.0.1:27017/test"; // change db name if not "test"

async function dropUsernameIndex() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const result = await mongoose.connection.db.collection("users").dropIndex("username_1");
    console.log("🗑️ Index dropped:", result);

    await mongoose.disconnect();
    console.log("✅ Disconnected");
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

dropUsernameIndex();
