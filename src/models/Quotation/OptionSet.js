const mongoose = require("mongoose");

const optionSetSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ["colorFinish", "glassSpec", "meshType", "generic"],
    },
    // Map of option label -> rate (number)
    values: {
      type: Map,
      of: Number,
      required: true,
      default: {},
    },
    system: { type: mongoose.Schema.Types.ObjectId, ref: "System" }, // optional per-system override
  },
  { timestamps: true }
);

optionSetSchema.index({ type: 1, system: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("OptionSet", optionSetSchema);
