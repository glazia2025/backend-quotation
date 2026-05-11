const mongoose = require("mongoose");

const systemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    colorFinishes: [{ type: String }],
    meshTypes: [{ type: String }],
    glassSpecs: [{ type: String }],
    handleColors: [{ type: String }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("System", systemSchema);
