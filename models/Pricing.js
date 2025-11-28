import mongoose from "mongoose";

const subjectSchema = mongoose.Schema({
  name: String,
  price: Number,
});

const pricingSchema = mongoose.Schema({
  curriculum: { type: String, required: true },
  packageCode: { type: String, required: true },
  grade: { type: String, required: true },
  subjects: [subjectSchema],
});

const Pricing = mongoose.model("Pricing", pricingSchema);

export default Pricing;
