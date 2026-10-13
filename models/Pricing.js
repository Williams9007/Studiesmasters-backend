import mongoose from "mongoose";

const subjectSchema = mongoose.Schema({
  name: String,
  price: Number,
});

const pricingSchema = mongoose.Schema({
  curriculum: { type: String, required: true, trim: true },
  packageCode: { type: String, required: true, trim: true },
  grade: { type: String, required: true, trim: true },
  subjects: [subjectSchema],
}, { timestamps: true });

const Pricing = mongoose.models.Pricing || mongoose.model("Pricing", pricingSchema);

export default Pricing;
