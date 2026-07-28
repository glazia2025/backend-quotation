const mongoose = require("mongoose");

const quotationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // New quotations store only references here. `items` is retained as a
    // read-only compatibility field for quotations created before normalization.
    quotationItems: [
      { type: mongoose.Schema.Types.ObjectId, ref: "QuotationItem" },
    ],
    items: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    customerDetails: {
      name: { type: String, default: "" },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      address: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      pincode: { type: String, default: "" },
    },
    quotationDetails: {
      id: { type: String, default: "" },
      date: {
        type: String,
        default: () => new Date().toISOString().split("T")[0],
      },
      opportunity: { type: String, default: "" },
      terms: {
        type: String,
        default:
          "1. Prices are valid for 30 days from the date of quotation.\n2. Payment terms: 50% advance, 50% on delivery.\n3. Delivery time: 15-20 working days.",
      },
      notes: { type: String, default: "" },
    },
    breakdown: {
      totalAmount: { type: Number },
      profitPercentage: { type: Number, default: 0 },
    },
    globalConfig: {
      logo: { type: String },
      website: { type: String },
      terms: { type: String },
      prerequisites: { type: String },
      additionalCosts: {
        installation: { type: Number, default: 0 },
        transport: { type: Number, default: 0 },
        loadingUnloading: { type: Number, default: 0 },
        discountPercent: { type: Number, default: 0 },
        showInstallation: { type: Boolean, default: true },
        showTransport: { type: Boolean, default: true },
        showLoadingUnloading: { type: Boolean, default: true },
        showDiscount: { type: Boolean, default: true },
      },
    },
    generatedId: { type: String, unique: true },
  },
  { timestamps: true }
);

quotationSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("Quotation", quotationSchema);
