const mongoose = require('mongoose');

// Define the product schema
const productSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  sapCode: { type: String, required: true },
  part: { type: String, required: true },
  degree: { type: String, required: true },
  description: { type: String, required: true },
  per: { type: String, required: true }, // Unit, Meter, etc.
  kgm: { type: Number, required: true },
  length: { type: String, required: true },
  image: { type: String, required: false },
  isEnabled: { type: Boolean, default: true },
});

// Define the profile options schema with dynamic categories
const profileOptionsSchema = new mongoose.Schema(
  {
    // Dynamic fields for categories (e.g., Casement, Sliding, etc.)
    categories: {
      type: Map,
      of: new mongoose.Schema({
        options: { type: [String], required: true },
        rate: { type: Map, of: String, required: true },
        enabled: { type: Map, of: Boolean, required: true },
        catEnabled: {type: Boolean, default: true},
        products: {
          type: Map,
          of: [productSchema],
          required: false,
        },
      }),
      required: true,
    },
  },
  { strict: false } // Allow flexibility in adding new categories
);

const ProfileOptions = mongoose.model('ProfileOptions', profileOptionsSchema);

module.exports = ProfileOptions;
