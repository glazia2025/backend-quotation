const mongoose = require("mongoose");

const userHardwareRateSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    hardware: { type: mongoose.Schema.Types.ObjectId, ref: "HardwareOptions", required: true },
    rate: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

userHardwareRateSchema.index({ user: 1, hardware: 1 }, { unique: true });

module.exports = mongoose.model("UserHardwareRate", userHardwareRateSchema);
