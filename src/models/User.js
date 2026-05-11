const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  gstNumber: { type: String, required: true },
  pincode: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },
  address: { type: String, required: true },
  phoneNumber: { type: String, required: true, unique: true }, // This is the primary mobile number for login
  phoneNumbers: { type: [String], default: [] }, // Additional login numbers (includes primary)
  paUrl: {type: String, required: false, default: null, unique: true},
  createdAt: {
    type: Date,
    default: new Date('2026-02-03')
  },
  dynamicPricing: {
    type: {
      hardware: {
        type: Map,
        of: Number,
        default: {}
      }, 
      profiles: {
        type: Map,
        of: Number,
        default: {}
      }
    },
    required: false,
    default: () => ({
      hardware: {},
      profiles: {}
    }),
    authorizedPerson: { type: String, required: true, default: '' },
    authorizedPersonDesignation: { type: String, required: true, default: '' }
  }
}, {timestamps: true });

userSchema.index({ phoneNumbers: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);

module.exports = User;
