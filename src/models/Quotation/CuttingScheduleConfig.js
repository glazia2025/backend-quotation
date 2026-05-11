const mongoose = require("mongoose");

const cuttingScheduleLineSchema = new mongoose.Schema(
  {
    itemType: {
      type: String,
      enum: ["profile", "hardware"],
      required: true,
      default: "profile",
    },
    sapCode: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    quantityFormula: { type: String, required: true, trim: true, default: "1" },
    dimensionFormula: { type: String, trim: true, default: "" },
    cutAngle: { type: String, trim: true, default: "" },
    position: { type: String, trim: true, default: "" },
    unit: { type: String, trim: true, default: "Pcs" },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: true }
);

const cuttingScheduleVariantSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      enum: ["45_45", "45_90", "90_45", "90_90"],
      required: true,
    },
    horizontalAngle: { type: String, enum: ["45", "90"], required: true },
    verticalAngle: { type: String, enum: ["45", "90"], required: true },
    lines: [cuttingScheduleLineSchema],
  },
  { _id: false }
);

const cuttingScheduleConfigSchema = new mongoose.Schema(
  {
    systemType: { type: String, required: true, trim: true },
    series: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    lines: [cuttingScheduleLineSchema],
    schedules: [cuttingScheduleVariantSchema],
    defaultScheduleKey: {
      type: String,
      enum: ["45_45", "45_90", "90_45", "90_90"],
      default: "90_90",
    },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

cuttingScheduleConfigSchema.index(
  { systemType: 1, series: 1, description: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "CuttingScheduleConfig",
  cuttingScheduleConfigSchema
);
