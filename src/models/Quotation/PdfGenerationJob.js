const mongoose = require("mongoose");

const pdfGenerationJobSchema = new mongoose.Schema(
  {
    quotation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Quotation",
      required: true,
      unique: true,
      index: true,
    },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    revision: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "dispatched", "processing", "failed"],
      default: "pending",
      index: true,
    },
    rerunRequested: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lockedAt: Date,
    lockedBy: String,
    lastError: String,
    dispatchedAt: Date,
    messageId: String,
  },
  { timestamps: true }
);

pdfGenerationJobSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

module.exports = mongoose.model("PdfGenerationJob", pdfGenerationJobSchema);
