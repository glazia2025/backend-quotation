const mongoose = require('mongoose');

const quotationConfigSchema = new mongoose.Schema({
    logo: { type: String },
    terms: { type: String },
    prerequisites: { type: String },
    additionalCosts: {
        installation: { type: Number, default: 0 },
        transport: { type: Number, default: 0 },
        loadingUnloading: { type: Number, default: 0 },
        discountPercent: { type: Number, default: 0 },
    },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
});

const QuotationConfig = mongoose.model('QuotationConfig', quotationConfigSchema);

module.exports = QuotationConfig;
