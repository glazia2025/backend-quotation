const mongoose = require('mongoose');
module.exports = {
  members: [{
    name: { type: String, required: true },
    phoneNumber: { type: String, required: true },
    role: { type: String, default: 'Member' },
    isActive: { type: Boolean, default: true },
    permissions: { type: mongoose.Schema.Types.Mixed, default: {} },
  }],
};
