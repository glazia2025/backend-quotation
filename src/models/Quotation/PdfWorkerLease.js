const mongoose = require("mongoose");

const pdfWorkerLeaseSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "pdf-worker-leader" },
    owner: { type: String, required: true },
    lockedUntil: { type: Date, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PdfWorkerLease", pdfWorkerLeaseSchema);
