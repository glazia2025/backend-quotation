const GlassBeadingConfig = require("../models/Quotation/GlassBeadingConfig");
const Series = require("../models/Quotation/Series");

const getDescriptionCatalog = async (_req, res) => {
  try {
    const series = await Series.find({})
      .populate("system", "name")
      .sort({ name: 1 })
      .lean();

    const configs = await GlassBeadingConfig.find({}).lean();

    const configMap = configs.reduce((acc, config) => {
      acc[`${config.systemType}||${config.series}||${config.description}`] = config;
      return acc;
    }, {});

    const descriptions = series.filter((seriesItem) => seriesItem.system?.name !== "Exhaust Fan").flatMap((seriesItem) =>
      (seriesItem.descriptions || []).map((description) => {
        const systemType = seriesItem.system?.name || "";
        const key = `${systemType}||${seriesItem.name}||${description.name}`;
        const config = configMap[key];

        return {
          systemType,
          series: seriesItem.name,
          description: description.name,
          configId: config?._id,
          configured: Boolean(config),
        };
      })
    );

    res.json({ descriptions });
  } catch (error) {
    console.error("getDescriptionCatalog error", error);
    res.status(500).json({
      message: "Unable to fetch glass beading descriptions",
    });
  }
};

const listConfigs = async (_req, res) => {
  try {
    const configs = await GlassBeadingConfig.find({})
      .sort({
        systemType: 1,
        series: 1,
        description: 1,
        glassSpec: 1,
      })
      .lean();

    res.json({ configs });
  } catch (error) {
    console.error("listConfigs error", error);
    res.status(500).json({
      message: "Unable to fetch glass beading configs",
    });
  }
};

const getConfig = async (req, res) => {
  try {
    const config = await GlassBeadingConfig.findById(req.params.id).lean();

    if (!config) {
      return res.status(404).json({
        message: "Glass beading config not found",
      });
    }

    res.json({ config });
  } catch (error) {
    console.error("getConfig error", error);
    res.status(500).json({
      message: "Unable to fetch glass beading config",
    });
  }
};

const normalizeBeadings = (beadings = []) =>
  (Array.isArray(beadings) ? beadings : []).map((beading) => ({
    sapCode: String(beading.sapCode || "").trim(),
    description: String(beading.description || "").trim(),
    formula: String(beading.formula || "").trim(),
    quantity: Number(beading.quantity) || 1,
  })).filter((beading) => beading.sapCode);
  

  const normalizeGaskets = (gaskets = []) =>
  (Array.isArray(gaskets) ? gaskets : []).map((gasket) => ({
    sapCode: String(gasket.sapCode || "").trim(),
    description: String(gasket.description || "").trim(),
    formula: String(gasket.formula || "").trim(),
  })) .filter((gasket) => gasket.sapCode);

  const upsertConfig = async (req, res) => {
  try {
    const payload = {
      glassSpec: String(req.body.glassSpec || "").trim(),
      systemType: String(req.body.systemType || "").trim(),
      series: String(req.body.series || "").trim(),
      description: String(req.body.description || "").trim(),
      beadings: normalizeBeadings(req.body.beadings),
      gaskets: normalizeGaskets(req.body.gaskets),
    };

    if (
      !payload.glassSpec ||
      !payload.systemType ||
      !payload.series ||
      !payload.description
    ) {
      return res.status(400).json({
        message:
          "glassSpec, systemType, series and description are required",
      });
    }

    console.log("Payload:", payload);

const existing = await GlassBeadingConfig.findOne({
  glassSpec: payload.glassSpec,
  systemType: payload.systemType,
  series: payload.series,
  description: payload.description,
});

console.log("Existing:", existing);
    const config = await GlassBeadingConfig.findOneAndUpdate(
      {
        glassSpec: payload.glassSpec,
        systemType: payload.systemType,
        series: payload.series,
        description: payload.description,
      },
      payload,
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    );

    res.json({
      message: "Glass beading config saved",
      config,
    });
  } catch (error) {
    console.error("upsertConfig error", error);
    res.status(500).json({
      message: "Unable to save glass beading config",
      error: error.message,
    });
  }
};

const deleteConfig = async (req, res) => {
  try {
    const config = await GlassBeadingConfig.findByIdAndDelete(req.params.id);

    if (!config) {
      return res.status(404).json({
        message: "Glass beading config not found",
      });
    }

    res.json({
      message: "Glass beading config deleted",
    });
  } catch (error) {
    console.error("deleteConfig error", error);
    res.status(500).json({
      message: "Unable to delete glass beading config",
    });
  }
};

module.exports = {
  getDescriptionCatalog,
  listConfigs,
  getConfig,
  upsertConfig,
  deleteConfig,
};
