const mongoose = require("mongoose");

const handleRuleSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    handleTypes: [{ type: String }],
    handleCount: { type: Number, default: 0 },
    systemType: { type: String }, // optional specificity
    series: { type: String }, // optional specificity
    notes: { type: String },
  },
  { timestamps: true }
);

handleRuleSchema.index(
  { description: 1, systemType: 1, series: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("HandleRule", handleRuleSchema);
