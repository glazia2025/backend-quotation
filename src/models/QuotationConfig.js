const mongoose = require('mongoose');

const quotationConfigSchema = new mongoose.Schema({
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
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
});

const QuotationConfig = mongoose.model('QuotationConfig', quotationConfigSchema);

module.exports = QuotationConfig;
