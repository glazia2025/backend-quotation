const QuotationConfig = require("../models/QuotationConfig");
const {
  collectQuotationImageKeys,
  deleteS3Keys,
  uploadQuotationImages,
} = require("../utils/quotationImages");

const getQuotationConfig = async (req, res) => {
  try {
    console.log(req.user);
    const config = await QuotationConfig.findOne({ user: req.user.userId }).lean();
    if (!config) {
      return res.status(404).json({ message: "Config not found" });
    }
    res.json(config);
  } catch (error) {
    console.error("Error fetching quotation config:", error);
    res.status(500).json({ message: "Error fetching quotation config" });
  }
};

const createOrUpdateQuotationConfig = async (req, res) => {
  let uploadedKeys = [];
  try {
    const existingConfig = await QuotationConfig.findOne({
      user: req.user.userId,
    }).lean();
    const previousImageKeys = collectQuotationImageKeys({
      globalConfig: existingConfig || {},
    });
    const prepared = await uploadQuotationImages({
      quotationId: `config-${req.user.userId}`,
      items: [],
      globalConfig: req.body,
    });
    uploadedKeys = prepared.uploadedKeys;

    const { _id: _ignoredId, user: _ignoredUser, ...payload } = req.body;
    payload.logo = prepared.globalConfig.logo;

    const config = await QuotationConfig.findOneAndUpdate(
      { user: req.user.userId },
      { ...payload, user: req.user.userId },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    const currentImageKeys = new Set(
      collectQuotationImageKeys({ globalConfig: config.toObject() })
    );
    await deleteS3Keys(
      previousImageKeys.filter((key) => !currentImageKeys.has(key))
    ).catch((error) => {
      console.warn("Failed to remove replaced quotation logo:", error.message);
    });
    res.json(config);
  } catch (error) {
    await deleteS3Keys(uploadedKeys).catch(() => {});
    console.error("Error updating quotation config:", error);
    res.status(error.statusCode || 500).json({
      message: error.message || "Error updating quotation config",
    });
  }
};

module.exports = {
  getQuotationConfig,
  createOrUpdateQuotationConfig,
};
