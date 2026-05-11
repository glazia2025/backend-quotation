const mongoose = require("mongoose");

const userDescriptionRateSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    systemType: { type: String, required: true },
    series: { type: String, required: true },
    description: { type: String, required: true },
    rates: {
      type: [{ type: Number, required: true }],
      required: true,
      validate: {
        validator: function (arr) {
          return Array.isArray(arr) && arr.length === 3;
        },
        message: "rates must contain exactly 3 values",
      },
    },
    notes: { type: String },
  },
  { timestamps: true }
);

userDescriptionRateSchema.index(
  { user: 1, systemType: 1, series: 1, description: 1 },
  { unique: true }
);

module.exports = mongoose.model("UserDescriptionRate", userDescriptionRateSchema);
