const mongoose = require("mongoose");

const areaSlabSchema = new mongoose.Schema(
  {
    label: { type: String },
    max: { type: Number, required: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AreaSlab", areaSlabSchema);
