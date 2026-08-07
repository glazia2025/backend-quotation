const HardwareLinkingConfig = require("../models/Quotation/HardwareLinkingConfig");
const Series = require("../models/Quotation/Series");
const OptionSet = require("../models/Quotation/OptionSet");
const Hardware = require("../models/Hardware");

const listCatalog = async (_req, res) => {
  try {
    const [series, configs] = await Promise.all([
      Series.find({}).populate("system", "name").sort({ name: 1 }).lean(),
      HardwareLinkingConfig.find({}).lean(),
    ]);
    const byKey = new Map(configs.map((row) => [`${row.systemType}||${row.series}||${row.description}`, row]));
    const descriptions = series.filter((seriesItem) => seriesItem.system?.name !== "Exhaust Fan").flatMap((seriesItem) => (seriesItem.descriptions || []).map((description) => {
      const systemType = seriesItem.system?.name || "";
      const config = byKey.get(`${systemType}||${seriesItem.name}||${description.name}`);
      return { systemType, series: seriesItem.name, description: description.name, configured: Boolean(config), configId: config?._id };
    }));
    res.json({ descriptions });
  } catch (error) { res.status(500).json({ message: "Unable to fetch hardware linking catalog", error: error.message }); }
};

const getFormOptions = async (_req, res) => {
  try {
    const [glassSet, hardware] = await Promise.all([
      OptionSet.findOne({ type: "glassSpec", system: { $exists: false } }).lean(),
      Hardware.find({})
        .select("sapCode perticular subCategory rate system moq")
        .sort({ sapCode: 1 })
        .lean(),
    ]);
    const values = glassSet?.values instanceof Map ? Object.fromEntries(glassSet.values) : (glassSet?.values || {});
    res.json({ glassSpecs: Object.keys(values), hardware });
  } catch (error) { res.status(500).json({ message: "Unable to fetch hardware linking options", error: error.message }); }
};

const listConfigs = async (_req, res) => res.json({ configs: await HardwareLinkingConfig.find({}).sort({ systemType: 1, series: 1, description: 1 }).lean() });
const getConfig = async (req, res) => {
  const config = await HardwareLinkingConfig.findById(req.params.id).lean();
  if (!config) return res.status(404).json({ message: "Hardware linking config not found" });
  res.json({ config });
};

const normalizeConfig = (body = {}) => ({
  systemType: String(body.systemType || "").trim(),
  series: String(body.series || "").trim(),
  description: String(body.description || "").trim(),
  shutterCount: Math.max(1, Math.round(Number(body.shutterCount) || 1)),
  glassRules: (Array.isArray(body.glassRules) ? body.glassRules : []).map((rule) => ({
    glassSpec: String(rule.glassSpec || "").trim(),
    conditions: (Array.isArray(rule.conditions) ? rule.conditions : []).map((condition) => ({
      operator: ["<", "<=", "=", ">=", ">"].includes(condition.operator) ? condition.operator : "<=",
      weightKg: Math.max(0, Number(condition.weightKg) || 0),
      hardware: (Array.isArray(condition.hardware) ? condition.hardware : []).map((line) => ({
        sapCode: String(line.sapCode || "").trim(), description: String(line.description || "").trim(),
        quantity: Math.max(0, Number(line.quantity) || 0),
        applicability: ["hinges", "frictionStay"].includes(line.applicability) ? line.applicability : "always",
      })).filter((line) => line.sapCode && line.quantity > 0),
    })),
  })).filter((rule) => rule.glassSpec),
});

const upsertConfig = async (req, res) => {
  try {
    const payload = normalizeConfig(req.body);
    if (!payload.systemType || !payload.series || !payload.description) return res.status(400).json({ message: "systemType, series and description are required" });
    const config = await HardwareLinkingConfig.findOneAndUpdate(
      { systemType: payload.systemType, series: payload.series, description: payload.description }, payload,
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    res.json({ message: "Hardware linking config saved", config });
  } catch (error) { res.status(500).json({ message: "Unable to save hardware linking config", error: error.message }); }
};
const deleteConfig = async (req, res) => {
  const config = await HardwareLinkingConfig.findByIdAndDelete(req.params.id);
  if (!config) return res.status(404).json({ message: "Hardware linking config not found" });
  res.json({ message: "Hardware linking config deleted" });
};

module.exports = { deleteConfig, getConfig, getFormOptions, listCatalog, listConfigs, upsertConfig };
