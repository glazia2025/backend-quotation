const mongoose = require("mongoose");

const baseRateSchema = new mongoose.Schema(
  {
    systemType: { type: String, required: true },
    series: { type: String, required: false, default: null },
description: { type: String, required: false, default: null },
    rates: {
      type: [{ type: Number, required: true }],
      required: true,
      validate: {
        validator: function (arr) {
          return Array.isArray(arr) && arr.length === 3;
        },
        message: "rates must contain exactly 3 values",
      },
    }, // fixed to 3 slabs
    notes: { type: String },
  },
  { timestamps: true }
);

baseRateSchema.index({ systemType: 1, series: 1, description: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("BaseRate", baseRateSchema);
