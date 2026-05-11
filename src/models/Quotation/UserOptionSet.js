const mongoose = require("mongoose");

const userOptionSetSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      required: true,
      enum: ["colorFinish", "glassSpec", "meshType"],
    },
    values: {
      type: Map,
      of: Number,
      required: true,
      default: {},
    },
  },
  { timestamps: true }
);

userOptionSetSchema.index({ user: 1, type: 1 }, { unique: true });

module.exports = mongoose.model("UserOptionSet", userOptionSetSchema);
