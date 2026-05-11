const mongoose = require("mongoose");

const userHardwareSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sapCode: { type: String, required: true },
    perticular: { type: String, required: true },
    subCategory: { type: String, required: true },
    rate: { type: Number, required: true },
    system: { type: String, required: true },
    moq: { type: String, required: true },
    image: { type: String },
  },
  { timestamps: true }
);

userHardwareSchema.index({ user: 1, sapCode: 1 }, { unique: true });
userHardwareSchema.index({ user: 1, subCategory: 1 });
userHardwareSchema.index({ sapCode: "text", perticular: "text" });

module.exports = mongoose.model("UserHardware", userHardwareSchema);
