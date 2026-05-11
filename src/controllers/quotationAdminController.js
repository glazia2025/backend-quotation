const System = require("../models/Quotation/System");
const Series = require("../models/Quotation/Series");
const OptionSet = require("../models/Quotation/OptionSet");
const AreaSlab = require("../models/Quotation/AreaSlab");
const BaseRate = require("../models/Quotation/BaseRate");
const HandleRule = require("../models/Quotation/HandleRule");
const HandleOption = require("../models/Quotation/HandleOption");
const User = require("../models/User");
const Quotation = require("../models/Quotation/Quotation");

const { normalizeRateMap, restoreRateMap } = require("../utils/rateMapUtils");
const { ensureColorDefaults } = require("../utils/handleOptionUtils");

const normalizeThreeRates = (input) => {
  if (Array.isArray(input)) {
    const nums = input.map((n) => Number(n) || 0);
    return [nums[0] || 0, nums[1] || 0, nums[2] || 0];
  }
  if (typeof input === "string") {
    const nums = input
      .split(/,|\n/)
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n));
    return [nums[0] || 0, nums[1] || 0, nums[2] || 0];
  }
  if (input && typeof input === "object") {
    const vals = Object.values(input).map((n) => Number(n) || 0);
    return [vals[0] || 0, vals[1] || 0, vals[2] || 0];
  }
  return [0, 0, 0];
};


// -------- System CRUD --------
const createSystem = async (req, res) => {
  try {
    const system = await System.create(req.body);
    res.status(201).json(system);
  } catch (error) {
    console.error("createSystem error", error);
    res.status(500).json({ message: "Unable to create system", error: error.message });
  }
};

const listSystems = async (_req, res) => {
  try {
    const systems = await System.find({}).sort({ name: 1 }).lean();
    res.json({ systems });
  } catch (error) {
    console.error("listSystems error", error);
    res.status(500).json({ message: "Unable to fetch systems" });
  }
};

const updateSystem = async (req, res) => {
  try {
    const system = await System.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!system) return res.status(404).json({ message: "System not found" });
    res.json(system);
  } catch (error) {
    console.error("updateSystem error", error);
    res.status(500).json({ message: "Unable to update system", error: error.message });
  }
};

const deleteSystem = async (req, res) => {
  try {
    const system = await System.findByIdAndDelete(req.params.id);
    if (!system) return res.status(404).json({ message: "System not found" });
    res.json({ message: "Deleted" });
  } catch (error) {
    console.error("deleteSystem error", error);
    res.status(500).json({ message: "Unable to delete system" });
  }
};

// -------- Series CRUD --------
const createSeries = async (req, res) => {
  try {
    const { systemId, systemName, ...payload } = req.body;

    let system = null;
    if (systemId) {
      system = await System.findById(systemId);
    } else if (systemName) {
      system = await System.findOne({ name: systemName });
    }

    if (!system) {
      return res.status(400).json({ message: "Valid system is required" });
    }

    const series = await Series.create({ ...payload, system: system._id });
    res.status(201).json(series);
  } catch (error) {
    console.error("createSeries error", error);
    res.status(500).json({ message: "Unable to create series", error: error.message });
  }
};

const listSeries = async (req, res) => {
  try {
    const filter = {};
    if (req.query.systemId) filter.system = req.query.systemId;
    if (req.query.systemName) {
      const sys = await System.findOne({ name: req.query.systemName });
      if (sys) filter.system = sys._id;
    }
    const series = await Series.find(filter).populate("system", "name").lean();
    res.json({ series });
  } catch (error) {
    console.error("listSeries error", error);
    res.status(500).json({ message: "Unable to fetch series" });
  }
};

const updateSeries = async (req, res) => {
  try {
    const { systemId, systemName, ...payload } = req.body;
    let systemUpdate = {};

    if (systemId) {
      systemUpdate.system = systemId;
    } else if (systemName) {
      const system = await System.findOne({ name: systemName });
      if (!system) return res.status(400).json({ message: "Invalid system name" });
      systemUpdate.system = system._id;
    }

    const series = await Series.findByIdAndUpdate(
      req.params.id,
      { ...payload, ...systemUpdate },
      { new: true, runValidators: true }
    );
    if (!series) return res.status(404).json({ message: "Series not found" });
    res.json(series);
  } catch (error) {
    console.error("updateSeries error", error);
    res.status(500).json({ message: "Unable to update series", error: error.message });
  }
};

const deleteSeries = async (req, res) => {
  try {
    const series = await Series.findByIdAndDelete(req.params.id);
    if (!series) return res.status(404).json({ message: "Series not found" });
    res.json({ message: "Deleted" });
  } catch (error) {
    console.error("deleteSeries error", error);
    res.status(500).json({ message: "Unable to delete series" });
  }
};

// -------- OptionSet CRUD --------
const createOptionSet = async (req, res) => {
  try {
    const { systemId, systemName, ...payload } = req.body;
    const constrainedTypes = ["colorFinish", "glassSpec", "meshType"];
    let system = null;
    if (!constrainedTypes.includes(payload.type)) {
      if (systemId) {
        system = await System.findById(systemId);
      } else if (systemName) {
        system = await System.findOne({ name: systemName });
      }
    }
    const optionSet = await OptionSet.create({
      ...payload,
      values: normalizeRateMap(payload.values),
      system: constrainedTypes.includes(payload.type) ? undefined : system?._id,
    });
    const normalized = optionSet.toObject();
    normalized.values = restoreRateMap(optionSet.values);
    res.status(201).json(normalized);
  } catch (error) {
    console.error("createOptionSet error", error);
    res.status(500).json({ message: "Unable to create option set", error: error.message });
  }
};

const listOptionSets = async (req, res) => {
  try {
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    const constrainedTypes = ["colorFinish", "glassSpec", "meshType"];
    if (!filter.type || !constrainedTypes.includes(filter.type)) {
      if (req.query.systemId) filter.system = req.query.systemId;
      if (req.query.systemName) {
        const sys = await System.findOne({ name: req.query.systemName });
        if (sys) filter.system = sys._id;
      }
    } else {
      filter.system = { $exists: false };
    }
    const optionSets = await OptionSet.find(filter).populate("system", "name").lean();
    const restored = optionSets.map((item) => ({
      ...item,
      values: restoreRateMap(item.values),
    }));
    res.json({ optionSets: restored });
  } catch (error) {
    console.error("listOptionSets error", error);
    res.status(500).json({ message: "Unable to fetch option sets" });
  }
};

const updateOptionSet = async (req, res) => {
  try {
    const { values, ...rest } = req.body;
    const payload = { ...rest };
    const constrainedTypes = ["colorFinish", "glassSpec", "meshType"];
    if (payload.type && constrainedTypes.includes(payload.type)) {
      payload.system = undefined;
    }
    if (values !== undefined) {
      payload.values = normalizeRateMap(values);
    }
    const optionSet = await OptionSet.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });
    if (!optionSet) return res.status(404).json({ message: "Option set not found" });
    const normalized = optionSet.toObject();
    normalized.values = restoreRateMap(optionSet.values);
    res.json(normalized);
  } catch (error) {
    console.error("updateOptionSet error", error);
    res.status(500).json({ message: "Unable to update option set", error: error.message });
  }
};

const deleteOptionSet = async (req, res) => {
  try {
    const optionSet = await OptionSet.findByIdAndDelete(req.params.id);
    if (!optionSet) return res.status(404).json({ message: "Option set not found" });
    res.json({ message: "Deleted" });
  } catch (error) {
    console.error("deleteOptionSet error", error);
    res.status(500).json({ message: "Unable to delete option set" });
  }
};

// -------- AreaSlab CRUD --------
const createAreaSlab = async (req, res) => {
  try {
    const slab = await AreaSlab.create(req.body);
    res.status(201).json(slab);
  } catch (error) {
    console.error("createAreaSlab error", error);
    res.status(500).json({ message: "Unable to create area slab", error: error.message });
  }
};

const listAreaSlabs = async (_req, res) => {
  try {
    const slabs = await AreaSlab.find({}).sort({ order: 1, max: 1 }).lean();
    res.json({ slabs });
  } catch (error) {
    console.error("listAreaSlabs error", error);
    res.status(500).json({ message: "Unable to fetch area slabs" });
  }
};

const updateAreaSlab = async (req, res) => {
  try {
    const slab = await AreaSlab.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!slab) return res.status(404).json({ message: "Area slab not found" });
    res.json(slab);
  } catch (error) {
    console.error("updateAreaSlab error", error);
    res.status(500).json({ message: "Unable to update area slab", error: error.message });
  }
};

const deleteAreaSlab = async (req, res) => {
  try {
    const slab = await AreaSlab.findByIdAndDelete(req.params.id);
    if (!slab) return res.status(404).json({ message: "Area slab not found" });
    res.json({ message: "Deleted" });
  } catch (error) {
    console.error("deleteAreaSlab error", error);
    res.status(500).json({ message: "Unable to delete area slab" });
  }
};

// -------- BaseRate CRUD --------
const createBaseRate = async (req, res) => {
  try {
    const payload = { ...req.body, rates: normalizeThreeRates(req.body.rates) };
    const baseRate = await BaseRate.create(payload);
    res.status(201).json(baseRate);
  } catch (error) {
    console.error("createBaseRate error", error);
    res.status(500).json({ message: "Unable to create base rate", error: error.message });
  }
};

const listBaseRates = async (req, res) => {
  try {
    const filter = {};
    if (req.query.systemType) filter.systemType = req.query.systemType;
    if (req.query.series) filter.series = req.query.series;
    if (req.query.description) filter.description = req.query.description;
    const baseRates = await BaseRate.find(filter).sort({ systemType: 1, series: 1, description: 1 }).lean();
    res.json({ baseRates });
  } catch (error) {
    console.error("listBaseRates error", error);
    res.status(500).json({ message: "Unable to fetch base rates" });
  }
};

const updateBaseRate = async (req, res) => {
  try {
    const payload = { ...req.body };
    if (payload.rates !== undefined) {
      payload.rates = normalizeThreeRates(payload.rates);
    }
    const baseRate = await BaseRate.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });
    if (!baseRate) return res.status(404).json({ message: "Base rate not found" });
    res.json(baseRate);
  } catch (error) {
    console.error("updateBaseRate error", error);
    res.status(500).json({ message: "Unable to update base rate", error: error.message });
  }
};

const deleteBaseRate = async (req, res) => {
  try {
    const baseRate = await BaseRate.findByIdAndDelete(req.params.id);
    if (!baseRate) return res.status(404).json({ message: "Base rate not found" });
    res.json({ message: "Deleted" });
  } catch (error) {
    console.error("deleteBaseRate error", error);
    res.status(500).json({ message: "Unable to delete base rate" });
  }
};

// -------- Handle Rules CRUD --------
const createHandleRule = async (req, res) => {
  try {
    const rule = await HandleRule.create(req.body);
    res.status(201).json(rule);
  } catch (error) {
    console.error("createHandleRule error", error);
    res.status(500).json({ message: "Unable to create handle rule", error: error.message });
  }
};

const listHandleRules = async (req, res) => {
  try {
    const filter = {};
    if (req.query.systemType) filter.systemType = req.query.systemType;
    if (req.query.series) filter.series = req.query.series;
    if (req.query.description) filter.description = req.query.description;
    const rules = await HandleRule.find(filter)
      .sort({ systemType: 1, series: 1, description: 1 })
      .lean();
    res.json({ rules });
  } catch (error) {
    console.error("listHandleRules error", error);
    res.status(500).json({ message: "Unable to fetch handle rules" });
  }
};

const updateHandleRule = async (req, res) => {
  try {
    const rule = await HandleRule.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!rule) return res.status(404).json({ message: "Handle rule not found" });
    res.json(rule);
  } catch (error) {
    console.error("updateHandleRule error", error);
    res.status(500).json({ message: "Unable to update handle rule", error: error.message });
  }
};

const deleteHandleRule = async (req, res) => {
  try {
    const rule = await HandleRule.findByIdAndDelete(req.params.id);
    if (!rule) return res.status(404).json({ message: "Handle rule not found" });
    res.json({ message: "Deleted" });
  } catch (error) {
    console.error("deleteHandleRule error", error);
    res.status(500).json({ message: "Unable to delete handle rule" });
  }
};
// -------- ADMIN QUOTATIONS (PHONE FILTER) --------

const listQuotationsByPhone = async (req, res) => {
  console.log("ADMIN QUOTATION API HIT");
  console.log("QUERY =", req.query);
  const { phone, page = 1, limit = 20 } = req.query;
  const currentPage = Math.max(parseInt(page) || 1, 1);
const perPage = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  try {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }
    let filter = {};
    if (phone) {
      const users = await User.find({
        phoneNumber: { $regex: phone, $options: "i" },
      }).select("_id");
      if (!users.length) {
        return res.json({
          quotations: [],
          total: 0,
          page: currentPage,
          totalPages: 0,
        });
      }
      filter.user = { $in: users.map((u) => u._id) };
    }
    //  Total count (for pagination)
    const total = await Quotation.countDocuments(filter);
    //  Paginated + lightweight data
    const quotations = await Quotation.find(filter)
      .select(
        "generatedId customerDetails breakdown quotationDetails createdAt user"
      )
      .populate("user", "name phoneNumber email")
      .sort({ createdAt: -1 })
      .limit(perPage)
      .skip((currentPage - 1) * perPage)
      .lean();
    res.json({
      quotations,
      total,
      page: currentPage,
      totalPages: Math.ceil(total / perPage),
    });

  } catch (error) {
    console.error("Admin quotation error:", error);
    res.status(500).json({ message: "Error fetching quotations" });
  }
};

module.exports = {
  // systems
  createSystem,
  listSystems,
  updateSystem,
  deleteSystem,
  // series
  createSeries,
  listSeries,
  updateSeries,
  deleteSeries,
  // option sets
  createOptionSet,
  listOptionSets,
  updateOptionSet,
  deleteOptionSet,
  // area slabs
  createAreaSlab,
  listAreaSlabs,
  updateAreaSlab,
  deleteAreaSlab,
  // base rates
  createBaseRate,
  listBaseRates,
  updateBaseRate,
  deleteBaseRate,
  // handle rules
  createHandleRule,
  listHandleRules,
  updateHandleRule,
  deleteHandleRule,
  listQuotationsByPhone,
  // handle options
  async createHandleOption(req, res) {
    try {
      const payload = { ...req.body };
      payload.colors = ensureColorDefaults(payload.colors);
      const option = await HandleOption.create(payload);
      res.status(201).json(option);
    } catch (error) {
      console.error("createHandleOption error", error);
      res.status(500).json({ message: "Unable to create handle option", error: error.message });
    }
  },
  async listHandleOptions(req, res) {
    try {
      const filter = {};
      if (req.query.systemType) filter.systemType = req.query.systemType;
      const options = await HandleOption.find(filter).sort({ systemType: 1, name: 1 }).lean();
      res.json({ options });
    } catch (error) {
      console.error("listHandleOptions error", error);
      res.status(500).json({ message: "Unable to fetch handle options" });
    }
  },
  async updateHandleOption(req, res) {
    try {
      const payload = { ...req.body };
      if (payload.colors) payload.colors = ensureColorDefaults(payload.colors);
      const option = await HandleOption.findByIdAndUpdate(req.params.id, payload, {
        new: true,
        runValidators: true,
      });
      if (!option) return res.status(404).json({ message: "Handle option not found" });
      res.json(option);
    } catch (error) {
      console.error("updateHandleOption error", error);
      res.status(500).json({ message: "Unable to update handle option", error: error.message });
    }
  },
  async deleteHandleOption(req, res) {
    try {
      const option = await HandleOption.findByIdAndDelete(req.params.id);
      if (!option) return res.status(404).json({ message: "Handle option not found" });
      res.json({ message: "Deleted" });
    } catch (error) {
      console.error("deleteHandleOption error", error);
      res.status(500).json({ message: "Unable to delete handle option" });
    }
  },
};
