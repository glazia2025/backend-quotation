const MullionCouplerConfig = require("../models/Quotation/MullionCouplerConfig");
const Series = require("../models/Quotation/Series");

const normalizeLines = (lines = []) =>
  (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      sapCode: String(line.sapCode || "").trim(),
      description: String(line.description || "").trim(),
      formula: String(line.formula || "").trim(),
      quantity: Number(line.quantity),
    }))
    .filter((line) => line.sapCode)
    .map((line) => ({
      ...line,
      formula: line.formula || "H",
      quantity: Number.isFinite(line.quantity) && line.quantity >= 1 ? line.quantity : 1,
    }));

const getSeriesCatalog = async (_req, res) => {
  try {
    const [series, configs] = await Promise.all([
      Series.find({}).populate("system", "name").sort({ name: 1 }).lean(),
      MullionCouplerConfig.find({}).lean(),
    ]);
    const bySeries = new Map(
      configs.map((config) => [
        `${config.systemType}||${config.series}`,
        config,
      ])
    );

    res.json({
      series: series.map((item) => {
        const systemType = item.system?.name || "";
        const config = bySeries.get(`${systemType}||${item.name}`);
        return {
          systemType,
          series: item.name,
          configId: config?._id,
          mullionCount: config?.mullions?.length || 0,
          couplerCount: config?.couplers?.length || 0,
          configured: Boolean(config?.mullions?.length || config?.couplers?.length),
        };
      }),
    });
  } catch (error) {
    console.error("getMullionCouplerSeriesCatalog error", error);
    res.status(500).json({ message: "Unable to fetch mullion/coupler series" });
  }
};

const listConfigs = async (_req, res) => {
  try {
    const configs = await MullionCouplerConfig.find({})
      .sort({ systemType: 1, series: 1 })
      .lean();
    res.json({ configs });
  } catch (error) {
    console.error("listMullionCouplerConfigs error", error);
    res.status(500).json({ message: "Unable to fetch mullion/coupler configs" });
  }
};

const getConfig = async (req, res) => {
  try {
    const config = await MullionCouplerConfig.findById(req.params.id).lean();
    if (!config) {
      return res.status(404).json({ message: "Mullion/coupler config not found" });
    }
    res.json({ config });
  } catch (error) {
    console.error("getMullionCouplerConfig error", error);
    res.status(500).json({ message: "Unable to fetch mullion/coupler config" });
  }
};

const upsertConfig = async (req, res) => {
  try {
    const payload = {
      systemType: String(req.body.systemType || "").trim(),
      series: String(req.body.series || "").trim(),
      mullions: normalizeLines(req.body.mullions),
      couplers: normalizeLines(req.body.couplers),
    };

    if (!payload.systemType || !payload.series) {
      return res.status(400).json({ message: "systemType and series are required" });
    }

    const config = await MullionCouplerConfig.findOneAndUpdate(
      { systemType: payload.systemType, series: payload.series },
      payload,
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    res.json({ message: "Mullion/coupler config saved", config });
  } catch (error) {
    console.error("upsertMullionCouplerConfig error", error);
    res.status(500).json({
      message: "Unable to save mullion/coupler config",
      error: error.message,
    });
  }
};

const deleteConfig = async (req, res) => {
  try {
    const config = await MullionCouplerConfig.findByIdAndDelete(req.params.id);
    if (!config) {
      return res.status(404).json({ message: "Mullion/coupler config not found" });
    }
    res.json({ message: "Mullion/coupler config deleted" });
  } catch (error) {
    console.error("deleteMullionCouplerConfig error", error);
    res.status(500).json({ message: "Unable to delete mullion/coupler config" });
  }
};

module.exports = {
  deleteConfig,
  getConfig,
  getSeriesCatalog,
  listConfigs,
  upsertConfig,
};
