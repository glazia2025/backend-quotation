const mongoose = require("mongoose");

const linkingLineSchema = new mongoose.Schema(
  {
    sapCode: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    formula: { type: String, required: true, trim: true, default: "H" },
    quantity: { type: Number, required: true, min: 1, default: 1 },
  },
  { _id: true }
);

const mullionCouplerConfigSchema = new mongoose.Schema(
  {
    systemType: { type: String, required: true, trim: true },
    series: { type: String, required: true, trim: true },
    mullions: { type: [linkingLineSchema], default: [] },
    couplers: { type: [linkingLineSchema], default: [] },
  },
  { timestamps: true }
);

mullionCouplerConfigSchema.index(
  { systemType: 1, series: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "MullionCouplerConfig",
  mullionCouplerConfigSchema
);
