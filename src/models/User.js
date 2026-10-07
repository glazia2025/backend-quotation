const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  ...require('./businessMemberFields'),
  isActive: { type: Boolean, default: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  gstNumber: { type: String, required: true },
  pincode: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },
  address: { type: String, required: true },
  phoneNumber: { type: String, required: true, unique: true }, // This is the primary mobile number for login
  paUrl: {type: String, required: false, default: null, unique: true},
  disabledModules: {
    type: [String],
    enum: ['MAIN_SITE', 'QUOTATION_ERP'],
    default: []
  },
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


userSchema.index({ 'members.phoneNumber': 1 }, { unique: true, partialFilterExpression: { 'members.phoneNumber': { $type: 'string' } } });

const User = mongoose.model('User', userSchema);

module.exports = User;
