const mongoose = require('mongoose');

// Define the product schema
const singleHardwareSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  sapCode: { type: String, required: true },
  perticular: { type: String, required: true },
  subCategory: { type: String, required: true},
  rate: { type: Number, required: true },
  system: { type: String, required: true }, // Unit, Meter, etc.
  moq: { type: String, required: true },
  image: { type: String, required: false },
});

singleHardwareSchema.index({ sapCode: 1 });
singleHardwareSchema.index({ sapCode: "text", perticular: "text" });

const HardwareOptions = mongoose.model('HardwareOptions', singleHardwareSchema, 'hardware');

module.exports = HardwareOptions;
