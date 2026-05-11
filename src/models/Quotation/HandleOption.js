const mongoose = require("mongoose");

const handleOptionSchema = new mongoose.Schema(
  {
    systemType: { type: String, required: true },
    name: { type: String, required: true },
    // color -> rate
    colors: {
      type: Map,
      of: Number,
      required: true,
      default: () => ({ Black: 0, Silver: 0 }),
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

handleOptionSchema.index({ systemType: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("HandleOption", handleOptionSchema);
