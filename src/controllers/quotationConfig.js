const QuotationConfig = require("../models/QuotationConfig");

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
  try {
    const {_id} = req.body;
    if (_id) {
      const config = await QuotationConfig.findOneAndUpdate(
            { user: req.user.userId },
            req.body,
            { new: true, upsert: true }
        );
      res.json(config);
    } else {
        const config = await QuotationConfig.create({...req.body, user: req.user.userId });
        res.json(config);
    }
    
  } catch (error) {
    console.error("Error updating quotation config:", error);
    res.status(500).json({ message: "Error updating quotation config" });
  }
};

module.exports = {
  getQuotationConfig,
  createOrUpdateQuotationConfig,
};
