const BaseRate = require("../models/Quotation/BaseRate");
const Series = require("../models/Quotation/Series");
const System = require("../models/Quotation/System");
const OptionSet = require("../models/Quotation/OptionSet");
const HandleOption = require("../models/Quotation/HandleOption");
const Hardware = require("../models/Hardware");
const UserDescriptionRate = require("../models/Quotation/UserDescriptionRate");
const UserOptionSet = require("../models/Quotation/UserOptionSet");
const UserHardware = require("../models/Quotation/UserHardware");
const UserHardwareRate = require("../models/Quotation/UserHardwareRate");
const { normalizeRateMap, restoreRateMap } = require("../utils/rateMapUtils");
const { ensureColorDefaults, groupHandleOptionsBySystem } = require("../utils/handleOptionUtils");

const ALLOWED_OPTION_TYPES = ["colorFinish", "glassSpec", "meshType"];

const escapeMongoKey = (key = "") =>
  String(key)
    .replace(/\./g, "[dot]")
    .replace(/\$/g, "[dollar]");

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

const toUserId = (req) => req.user?.userId;

const ensureUserContext = (req, res) => {
  if (!toUserId(req)) {
    res.status(401).json({ message: "Authenticated user is required" });
    return false;
  }
  return true;
};

const ensureAllowedType = (type, res) => {
  if (!ALLOWED_OPTION_TYPES.includes(type)) {
    res.status(400).json({ message: "type must be one of colorFinish, glassSpec, meshType" });
    return false;
  }
  return true;
};

const resolveAdminFallbackRate = (adminRate, userRate) => {
  const asUserRate = Number(userRate);
  if (!Number.isFinite(asUserRate) || asUserRate === 0) {
    return Number(adminRate) || 0;
  }
  return asUserRate;
};

const mergeOptionItems = (adminValues = {}, userValues = {}) => {
  const allNames = Array.from(new Set([...Object.keys(adminValues), ...Object.keys(userValues)])).sort();
  return allNames.map((name) => {
    const adminRate = adminValues[name];
    const userRate = userValues[name];
    const hasAdmin = Object.prototype.hasOwnProperty.call(adminValues, name);
    const hasUser = Object.prototype.hasOwnProperty.call(userValues, name);
    const rate = hasAdmin ? resolveAdminFallbackRate(adminRate, userRate) : Number(userRate) || 0;

    return {
      name,
      rate,
      adminRate: hasAdmin ? Number(adminRate) || 0 : null,
      userRate: hasUser ? Number(userRate) || 0 : null,
      source: hasAdmin ? "admin" : "user",
      canDelete: !hasAdmin,
    };
  });
};

const doesDescriptionExist = async (systemType, series, description) => {
  const existingRate = await BaseRate.findOne({ systemType, series, description }).lean();
  if (existingRate) return true;

  const systemDoc = await System.findOne({ name: systemType }).lean();
  if (!systemDoc) return false;

  const seriesDoc = await Series.findOne({ name: series, system: systemDoc._id })
    .select("descriptions")
    .lean();
  if (!seriesDoc) return false;

  return (seriesDoc.descriptions || []).some((item) => item.name === description);
};

const upsertDescriptionRate = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const userId = toUserId(req);
    const { systemType, series, description, notes } = req.body;
    const rates = normalizeThreeRates(req.body.rates);

    if (!systemType || !series || !description) {
      return res.status(400).json({ message: "systemType, series and description are required" });
    }

    const exists = await doesDescriptionExist(systemType, series, description);
    if (!exists) {
      return res.status(400).json({
        message: "Description does not exist in admin master data. Only rate override is allowed.",
      });
    }

    const doc = await UserDescriptionRate.findOneAndUpdate(
      { user: userId, systemType, series, description },
      { rates, notes },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    res.json(doc);
  } catch (error) {
    console.error("upsertDescriptionRate error", error);
    res.status(500).json({ message: "Unable to save description rates", error: error.message });
  }
};

const listDescriptionRates = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const userId = toUserId(req);
    const filter = {};
    if (req.query.systemType) filter.systemType = req.query.systemType;
    if (req.query.series) filter.series = req.query.series;
    if (req.query.description) filter.description = req.query.description;

    const [userRates, adminRates] = await Promise.all([
      UserDescriptionRate.find({ user: userId, ...filter }).lean(),
      BaseRate.find(filter).lean(),
    ]);

    const userByKey = userRates.reduce((acc, row) => {
      const key = `${row.systemType}|${row.series}|${row.description}`;
      acc[key] = row;
      return acc;
    }, {});

    const rates = adminRates.map((adminRate) => {
      const key = `${adminRate.systemType}|${adminRate.series}|${adminRate.description}`;
      const userRate = userByKey[key];
      const adminRatesArr = Array.isArray(adminRate.rates) ? adminRate.rates : [0, 0, 0];
      const userRatesArr = Array.isArray(userRate?.rates) ? userRate.rates : [0, 0, 0];
      const effectiveRates = [0, 1, 2].map((idx) =>
        resolveAdminFallbackRate(adminRatesArr[idx], userRatesArr[idx])
      );

      return {
        ...adminRate,
        source: "admin",
        adminRateId: adminRate._id,
        userRateId: userRate?._id || null,
        adminRates: adminRatesArr,
        userRates: userRate ? userRatesArr : null,
        rates: effectiveRates,
        canDelete: false,
      };
    });

    rates.sort((a, b) => {
      if (a.systemType !== b.systemType) return a.systemType.localeCompare(b.systemType);
      if (a.series !== b.series) return a.series.localeCompare(b.series);
      return a.description.localeCompare(b.description);
    });

    res.json({ rates });
  } catch (error) {
    console.error("listDescriptionRates error", error);
    res.status(500).json({ message: "Unable to fetch description rates", error: error.message });
  }
};

const updateDescriptionRate = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const payload = { ...req.body };
    if (payload.rates !== undefined) {
      payload.rates = normalizeThreeRates(payload.rates);
    }

    const updated = await UserDescriptionRate.findOneAndUpdate(
      { _id: req.params.id, user: toUserId(req) },
      payload,
      { new: true, runValidators: true }
    );

    if (!updated) return res.status(404).json({ message: "User description rate not found" });
    res.json(updated);
  } catch (error) {
    console.error("updateDescriptionRate error", error);
    res.status(500).json({ message: "Unable to update description rates", error: error.message });
  }
};

const deleteDescriptionRate = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const deleted = await UserDescriptionRate.findOneAndDelete({
      _id: req.params.id,
      user: toUserId(req),
    });
    if (!deleted) return res.status(404).json({ message: "User description rate not found" });
    res.json({ message: "Deleted" });
  } catch (error) {
    console.error("deleteDescriptionRate error", error);
    res.status(500).json({ message: "Unable to delete description rates", error: error.message });
  }
};

const listOptionSets = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const userId = toUserId(req);
    const types = ALLOWED_OPTION_TYPES;

    const [adminDocs, userDocs, handleOptions] = await Promise.all([
      OptionSet.find({ type: { $in: types } }).populate("system", "name").lean(),
      UserOptionSet.find({ user: userId, type: { $in: types } }).lean(),
      HandleOption.find({
        $or: [
          { createdBy: { $exists: false } },
          { createdBy: null },
          { createdBy: userId },
        ],
      }).sort({ systemType: 1, name: 1 }).lean(),
    ]);

    const adminByType = adminDocs.reduce((acc, doc) => {
      if (!acc[doc.type]) acc[doc.type] = [];
      acc[doc.type].push(doc);
      return acc;
    }, {});
    const userByType = userDocs.reduce((acc, doc) => {
      acc[doc.type] = restoreRateMap(doc.values);
      return acc;
    }, {});

    const optionSets = types.map((t) => {
      const typeDocs = adminByType[t] || [];
      const userValues = userByType[t] || {};

      const globalAdminDoc = typeDocs.find((doc) => !doc.system);
      const adminValues = restoreRateMap(globalAdminDoc?.values);
      const items = mergeOptionItems(adminValues, userValues);

      return {
        type: t,
        items,
      };
    });

    res.json({
      optionSets: [
        ...optionSets,
        { type: "handle", items: groupHandleOptionsBySystem(handleOptions, userId) },
      ],
    });
  } catch (error) {
    console.error("listOptionSets (user) error", error);
    res.status(500).json({ message: "Unable to fetch option sets", error: error.message });
  }
};

const replaceOptionSet = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  const { type } = req.params;
  if (!ensureAllowedType(type, res)) return;

  try {
    const doc = await UserOptionSet.findOneAndUpdate(
      { user: toUserId(req), type },
      { values: normalizeRateMap(req.body.values || {}) },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    const normalized = doc.toObject();
    normalized.values = restoreRateMap(doc.values);
    res.json(normalized);
  } catch (error) {
    console.error("replaceOptionSet error", error);
    res.status(500).json({ message: "Unable to update option set", error: error.message });
  }
};

const upsertOptionItem = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  const { type } = req.params;
  if (!ensureAllowedType(type, res)) return;

  const { name, rate } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ message: "name is required" });
  }

  try {
    const adminOptionSet = await OptionSet.findOne({
      type,
      system: { $exists: false },
    }).lean();
    const adminValues = restoreRateMap(adminOptionSet?.values);
    if (Object.prototype.hasOwnProperty.call(adminValues, name)) {
      return res.status(400).json({
        message: "This is an admin option. Use the admin-rate endpoint to set your rate.",
      });
    }

    const key = escapeMongoKey(name);
    const numericRate = Number(rate) || 0;
    const updated = await UserOptionSet.findOneAndUpdate(
      { user: toUserId(req), type },
      { $set: { [`values.${key}`]: numericRate } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    const normalized = updated.toObject();
    normalized.values = restoreRateMap(updated.values);
    res.json(normalized);
  } catch (error) {
    console.error("upsertOptionItem error", error);
    res.status(500).json({ message: "Unable to save option item", error: error.message });
  }
};

const deleteOptionItem = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  const { type, name } = req.params;
  if (!ensureAllowedType(type, res)) return;

  try {
    const adminOptionSet = await OptionSet.findOne({
      type,
      system: { $exists: false },
    }).lean();
    const adminValues = restoreRateMap(adminOptionSet?.values);
    if (Object.prototype.hasOwnProperty.call(adminValues, name)) {
      return res.status(400).json({
        message: "Admin option cannot be deleted by user",
      });
    }

    const key = escapeMongoKey(name);
    const updated = await UserOptionSet.findOneAndUpdate(
      { user: toUserId(req), type },
      { $unset: { [`values.${key}`]: 1 } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: "User option set not found" });
    const normalized = updated.toObject();
    normalized.values = restoreRateMap(updated.values);
    res.json(normalized);
  } catch (error) {
    console.error("deleteOptionItem error", error);
    res.status(500).json({ message: "Unable to delete option item", error: error.message });
  }
};

const setAdminOptionItemRate = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  const { type, name } = req.params;
  if (!ensureAllowedType(type, res)) return;

  try {
    const adminOptionSet = await OptionSet.findOne({
      type,
      system: { $exists: false },
    }).lean();
    const adminValues = restoreRateMap(adminOptionSet?.values);
    if (!Object.prototype.hasOwnProperty.call(adminValues, name)) {
      return res.status(404).json({ message: "Admin option item not found" });
    }

    const key = escapeMongoKey(name);
    const numericRate = Number(req.body.rate) || 0;
    const updated = await UserOptionSet.findOneAndUpdate(
      { user: toUserId(req), type },
      { $set: { [`values.${key}`]: numericRate } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    const normalized = updated.toObject();
    normalized.values = restoreRateMap(updated.values);
    res.json({
      type,
      name,
      adminRate: Number(adminValues[name]) || 0,
      userRate: numericRate,
      rate: resolveAdminFallbackRate(adminValues[name], numericRate),
      optionSet: normalized,
    });
  } catch (error) {
    console.error("setAdminOptionItemRate error", error);
    res.status(500).json({ message: "Unable to set admin option rate", error: error.message });
  }
};

const addHardware = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const payload = {
      user: toUserId(req),
      sapCode: req.body.sapCode,
      perticular: req.body.perticular,
      subCategory: req.body.subCategory,
      rate: Number(req.body.rate),
      system: req.body.system,
      moq: req.body.moq,
      image: req.body.image,
    };

    const created = await UserHardware.create(payload);
    res.status(201).json({ product: created });
  } catch (error) {
    console.error("addUserHardware error", error);
    res.status(500).json({ message: "Unable to add hardware", error: error.message });
  }
};

const listHardware = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const subCategory = req.query.subCategory;
    const search = req.query.search;

    const userQuery = { user: toUserId(req) };
    const adminQuery = {};
    if (subCategory) {
      userQuery.subCategory = subCategory;
      adminQuery.subCategory = subCategory;
    }
    if (search) {
      const pattern = { $regex: search, $options: "i" };
      userQuery.$or = [{ sapCode: pattern }, { perticular: pattern }];
      adminQuery.$or = [{ sapCode: pattern }, { perticular: pattern }];
    }

    const [userProducts, adminProducts, adminOverrides] = await Promise.all([
      UserHardware.find(userQuery).sort({ subCategory: 1, perticular: 1 }).lean(),
      Hardware.find(adminQuery).sort({ subCategory: 1, perticular: 1 }).lean(),
      UserHardwareRate.find({ user: toUserId(req) }).lean(),
    ]);

    const overrideMap = adminOverrides.reduce((acc, row) => {
      acc[String(row.hardware)] = Number(row.rate) || 0;
      return acc;
    }, {});

    const adminRows = adminProducts.map((item) => {
      const adminRate = Number(item.rate) || 0;
      const userRate = overrideMap[String(item._id)];
      return {
        ...item,
        source: "admin",
        adminRate,
        userRate: Number.isFinite(userRate) ? userRate : null,
        rate: resolveAdminFallbackRate(adminRate, userRate),
        canDelete: false,
      };
    });

    const userRows = userProducts.map((item) => ({
      ...item,
      source: "user",
      adminRate: null,
      userRate: Number(item.rate) || 0,
      rate: Number(item.rate) || 0,
      canDelete: true,
    }));

    const products = [...adminRows, ...userRows];
    const options = Array.from(new Set(products.map((item) => item.subCategory).filter(Boolean))).sort();

    res.json({ options, products });
  } catch (error) {
    console.error("listUserHardware error", error);
    res.status(500).json({ message: "Unable to fetch hardware", error: error.message });
  }
};

const updateHardware = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const payload = { ...req.body };
    if (payload.rate !== undefined) payload.rate = Number(payload.rate) || 0;

    const updated = await UserHardware.findOneAndUpdate(
      { _id: req.params.id, user: toUserId(req) },
      payload,
      { new: true, runValidators: true }
    );

    if (!updated) return res.status(404).json({ message: "User hardware not found" });
    res.json({ product: updated });
  } catch (error) {
    console.error("updateUserHardware error", error);
    res.status(500).json({ message: "Unable to update hardware", error: error.message });
  }
};

const deleteHardware = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const deleted = await UserHardware.findOneAndDelete({
      _id: req.params.id,
      user: toUserId(req),
    });
    if (!deleted) return res.status(404).json({ message: "User hardware not found" });
    res.json({ message: "Deleted" });
  } catch (error) {
    console.error("deleteUserHardware error", error);
    res.status(500).json({ message: "Unable to delete hardware", error: error.message });
  }
};

const setAdminHardwareRate = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const { hardwareId } = req.params;
    const rate = Number(req.body.rate) || 0;

    const adminHardware = await Hardware.findById(hardwareId).lean();
    if (!adminHardware) {
      return res.status(404).json({ message: "Admin hardware not found" });
    }

    const override = await UserHardwareRate.findOneAndUpdate(
      { user: toUserId(req), hardware: hardwareId },
      { rate },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    res.json({
      hardwareId,
      adminRate: Number(adminHardware.rate) || 0,
      userRate: Number(override.rate) || 0,
      rate: resolveAdminFallbackRate(adminHardware.rate, override.rate),
    });
  } catch (error) {
    console.error("setAdminHardwareRate error", error);
    res.status(500).json({ message: "Unable to set admin hardware rate", error: error.message });
  }
};

const createHandleOption = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const payload = {
      systemType: req.body.systemType,
      name: req.body.name,
      colors: ensureColorDefaults(req.body.colors),
      createdBy: toUserId(req),
    };
    const option = await HandleOption.create(payload);
    res.status(201).json(option);
  } catch (error) {
    console.error("createHandleOption (user) error", error);
    res.status(500).json({ message: "Unable to create handle option", error: error.message });
  }
};

const updateHandleOption = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

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
    console.error("updateHandleOption (user) error", error);
    res.status(500).json({ message: "Unable to update handle option", error: error.message });
  }
};

const deleteHandleOption = async (req, res) => {
  if (!ensureUserContext(req, res)) return;

  try {
    const option = await HandleOption.findOneAndDelete({
      _id: req.params.id,
      createdBy: toUserId(req),
    });
    if (!option) return res.status(404).json({ message: "User handle option not found" });
    res.json({ message: "Deleted" });
  } catch (error) {
    console.error("deleteHandleOption (user) error", error);
    res.status(500).json({ message: "Unable to delete handle option", error: error.message });
  }
};

module.exports = {
  upsertDescriptionRate,
  listDescriptionRates,
  updateDescriptionRate,
  deleteDescriptionRate,
  listOptionSets,
  replaceOptionSet,
  upsertOptionItem,
  deleteOptionItem,
  setAdminOptionItemRate,
  addHardware,
  listHardware,
  updateHardware,
  deleteHardware,
  setAdminHardwareRate,
  createHandleOption,
  updateHandleOption,
  deleteHandleOption,
};
