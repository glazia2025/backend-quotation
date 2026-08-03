const mongoose = require("mongoose");

const itemFields = {
  refCode: String,
  location: String,
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  area: { type: Number, default: 0 },
  systemType: String,
  series: String,
  description: String,
  colorFinish: String,
  glassSpec: String,
  hardwareOpeningType: {
    type: String,
    enum: ["", "hinges", "frictionStay"],
    default: "",
  },
  handleType: String,
  handleColor: String,
  handleCount: { type: Number, default: 0 },
  meshPresent: { type: Boolean, default: false },
  meshType: String,
  rate: { type: Number, default: 0 },
  quantity: { type: Number, default: 1 },
  amount: { type: Number, default: 0 },
  refImage: String,
  remarks: String,
  frameCutAngle: { type: String, enum: ["45", "90"], default: "90" },
  shutterCutAngle: { type: String, enum: ["45", "90"], default: "90" },
  cuttingScheduleKey: {
    type: String,
    enum: ["45_45", "45_90", "90_45", "90_90"],
    default: "90_90",
  },
  sash: String,
  panelSashes: [String],
  hasExhaustFan: { type: Boolean, default: false },
  exhaustFanX: Number,
  exhaustFanY: Number,
  exhaustFanSize: Number,
  archType: {
    type: String,
    enum: ["none", "circular", "triangle"],
    default: "none",
  },
  archHeightRatio: Number,
  baseRate: { type: Number, default: 0 },
  areaSlabIndex: { type: Number, default: 0 },
  rateSource: {
    type: String,
    enum: ["calculated", "manual", "legacy"],
    default: "legacy",
  },
  calculatedBaseRate: Number,
  calculatedFinalRate: Number,
  nalcoPriceUsed: Number,
  nalcoRatePerKg: Number,
  profileWeightKg: Number,
  profileMaterialValue: Number,
  rateCalculatedAt: Date,
  rateCalculationVersion: Number,
  configuratorLayout: mongoose.Schema.Types.Mixed,
};

const quotationItemSchema = new mongoose.Schema(
  {
    quotation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Quotation",
      required: true,
      index: true,
    },
    parentItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "QuotationItem",
      default: null,
    },
    subItems: [{ type: mongoose.Schema.Types.ObjectId, ref: "QuotationItem" }],
    joins: [
      {
        p1: {
          type: String,
          required: true,
          trim: true,
        },
        p2: {
          type: String,
          required: true,
          trim: true,
        },
        type: {
          type: String,
          enum: ["Mullion", "Coupler"],
          required: true,
        },
      },
    ],
    ...itemFields,
  },
  { timestamps: true }
);

quotationItemSchema.index({ quotation: 1, parentItem: 1 });
quotationItemSchema.index({ quotation: 1, systemType: 1, series: 1, description: 1 });

module.exports = mongoose.model("QuotationItem", quotationItemSchema);
