const mongoose = require("mongoose");

const descriptionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    handleTypes: [{ type: String }],
    handleCount: { type: Number, required: true, default: 0 },
    remarks: { type: String },
  },
  { _id: false }
);

const seriesSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    system: { type: mongoose.Schema.Types.ObjectId, ref: "System", required: true },
    descriptions: [descriptionSchema],
    baseRateOverrides: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

seriesSchema.index({ name: 1, system: 1 }, { unique: true });

module.exports = mongoose.model("Series", seriesSchema);
