const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    uniqueKey: String, // SAP code or ID from migration
    sapCode: String,
    part: String,
    description: String,
    degree: String,
    per: String,
    kgm: Number,
    length: Number,
    image: String,
    enabled: Boolean
  },
  { timestamps: true }
);

ProductSchema.index({ sapCode: 1 });
ProductSchema.index({ sapCode: "text", part: "text", description: "text" });

module.exports = mongoose.model("Product", ProductSchema);
