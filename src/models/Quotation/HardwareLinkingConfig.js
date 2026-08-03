const mongoose = require("mongoose");

const hardwareLineSchema = new mongoose.Schema({
  sapCode: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: "" },
  quantity: { type: Number, min: 0, default: 1 },
  applicability: {
    type: String,
    enum: ["always", "hinges", "frictionStay"],
    default: "always",
  },
}, { _id: true });

const conditionSchema = new mongoose.Schema({
  operator: { type: String, enum: ["<", "<=", "=", ">=", ">"], required: true },
  weightKg: { type: Number, min: 0, required: true },
  hardware: { type: [hardwareLineSchema], default: [] },
}, { _id: true });

const glassRuleSchema = new mongoose.Schema({
  glassSpec: { type: String, required: true, trim: true },
  conditions: { type: [conditionSchema], default: [] },
}, { _id: true });

const schema = new mongoose.Schema({
  systemType: { type: String, required: true, trim: true },
  series: { type: String, required: true, trim: true },
  description: { type: String, required: true, trim: true },
  shutterCount: { type: Number, min: 1, default: 1 },
  glassRules: { type: [glassRuleSchema], default: [] },
}, { timestamps: true });

schema.index({ systemType: 1, series: 1, description: 1 }, { unique: true });

module.exports = mongoose.model("HardwareLinkingConfig", schema);
