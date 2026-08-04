const mongoose = require("mongoose");

const CuttingScheduleConfig = require("../models/Quotation/CuttingScheduleConfig");
const GlassBeadingConfig = require("../models/Quotation/GlassBeadingConfig");
const MullionCouplerConfig = require("../models/Quotation/MullionCouplerConfig");
const HardwareLinkingConfig = require("../models/Quotation/HardwareLinkingConfig");
const Hardware = require("../models/Hardware");
const Product = require("../models/Product");
const ProfileOptions = require("../models/ProfileOptions");
const User = require("../models/User");
const { evaluateFormula, round3, toNumber } = require("../utils/cuttingSchedule");
const { restoreRateMap } = require("../utils/rateMapUtils");
const { resolveLinkedHardware } = require("../utils/hardwareLinking");

const DEFAULT_PROFILE_ADJUSTMENT = 100;
const CUT_ALLOWANCE_MM = 10;

const round2 = (value) => Math.round(toNumber(value) * 100) / 100;

const getJoinPricingLines = (lines, orientation) => {
  const configuredLines = Array.isArray(lines) ? lines : [];
  const dimensionVariable = orientation === "vertical"
    ? "W"
    : orientation === "horizontal"
      ? "H"
      : "";
  if (!dimensionVariable) return configuredLines;
  const matchingLines = configuredLines.filter((line) =>
    new RegExp(`\\b${dimensionVariable}\\b`, "i").test(String(line.formula || ""))
  );
  return matchingLines.length ? matchingLines : configuredLines;
};

const getLatestNalcoPrice = async () => {
  const schema = new mongoose.Schema(
    { nalcoPrice: Number, date: Date },
    { collection: "nalcos" }
  );
  const Nalco = mongoose.models.nalco || mongoose.model("nalco", schema);
  const latest = await Nalco.findOne({}).sort({ date: -1 }).lean();
  return toNumber(latest?.nalcoPrice);
};

const scheduleKeyForItem = (item = {}) => {
  const explicit = String(item.cuttingScheduleKey || "").trim();
  if (/^(45|90)_(45|90)$/.test(explicit)) return explicit;
  const frame = String(item.frameCutAngle) === "45" ? "45" : "90";
  const shutter = String(item.shutterCutAngle) === "45" ? "45" : "90";
  return `${frame}_${shutter}`;
};

const findSchedule = (config, key) => {
  const schedules = Array.isArray(config?.schedules) ? config.schedules : [];
  const selected = schedules.find((schedule) => schedule.key === key);
  if (selected?.lines?.length) return selected;
  if (key === "90_90" && Array.isArray(config?.lines) && config.lines.length) {
    return { key, lines: config.lines };
  }
  return null;
};

const buildProfileMetadataMap = (profileOptions) => {
  const result = new Map();
  const categories = profileOptions?.categories || {};
  const categoryEntries = categories instanceof Map
    ? Array.from(categories.entries())
    : Object.entries(categories);

  categoryEntries.forEach(([categoryName, category]) => {
    const products = category?.products || {};
    const productEntries = products instanceof Map
      ? Array.from(products.entries())
      : Object.entries(products);
    productEntries.forEach(([optionName, rows]) => {
      (Array.isArray(rows) ? rows : []).forEach((row) => {
        const sapCode = String(row?.sapCode || "").trim().toUpperCase();
        if (sapCode) result.set(sapCode, {
          ...row,
          categoryName,
          optionName,
          configuredRate: toNumber(category?.rate instanceof Map ? category.rate.get(optionName) : category?.rate?.[optionName]),
        });
      });
    });
  });
  return result;
};

const resolveProfileAdjustment = (pricing, profile) => {
  const category = String(profile?.categoryName || "").trim();
  const option = String(profile?.optionName || "").trim();
  const candidates = [
    category && option ? `${category} - ${option}` : "",
    category && option ? `${category}-${option}` : "",
    category,
  ].filter(Boolean);
  for (const key of candidates) {
    if (!Object.prototype.hasOwnProperty.call(pricing, key)) continue;
    const value = Number(pricing[key]);
    if (Number.isFinite(value) && value !== 0) return value;
    return DEFAULT_PROFILE_ADJUSTMENT;
  }
  return DEFAULT_PROFILE_ADJUSTMENT;
};

const calculateProfileMaterialBaseRate = ({
  item,
  schedule,
  productsByCode,
  profileMetadataByCode,
  profilePricing,
  hardwareByCode = new Map(),
  hardwarePricing = {},
  glassBeadingConfig,
  hardwareLinkingConfig,
  nalcoPrice,
}) => {
  const width = toNumber(item.frameWidth, toNumber(item.width));
  const height = toNumber(item.frameHeight, toNumber(item.height));
  const area = toNumber(item.area) ||
    (width > 0 && height > 0 ? (width * height) / (304.8 * 304.8) : 0);
  if (area <= 0) throw new Error("Item area must be greater than zero");

  const variables = { W: width, H: height, AREA: area, Q: 1 };
  const profiles = [];
  const warnings = [];
  let materialValue = 0;
  let totalWeightKg = 0;
  const otherMaterials = [];

  (schedule?.lines || []).filter((line) => line.itemType === "profile").forEach((line) => {
    const code = String(line.sapCode || "").trim().toUpperCase();
    const product = productsByCode.get(code);
    const metadata = profileMetadataByCode.get(code) || product;
    if (!product && !metadata) {
      warnings.push(`Profile ${line.sapCode || line.description || "unknown"} was not found`);
      return;
    }
    const kgm = toNumber(metadata?.kgm, toNumber(product?.kgm));
    if (kgm <= 0) {
      warnings.push(`Profile ${line.sapCode} has no kg/m value`);
      return;
    }
    const pieceQuantity = Math.max(
      0,
      toNumber(evaluateFormula(line.quantityFormula || "1", variables))
    );
    const cutLengthMm = toNumber(
      evaluateFormula(line.dimensionFormula || "0", variables)
    );
    if (pieceQuantity <= 0 || cutLengthMm <= 0) return;
    const billedLengthMm = cutLengthMm + CUT_ALLOWANCE_MM;
    const weightKg = round3(pieceQuantity * (billedLengthMm / 1000) * kgm);
    const adjustment = resolveProfileAdjustment(profilePricing, metadata);
    const ratePerKg = round2(nalcoPrice / 1000 + adjustment);
    const amount = round2(weightKg * ratePerKg);
    materialValue += amount;
    totalWeightKg += weightKg;
    profiles.push({
      sapCode: line.sapCode,
      description: line.description || product?.description || metadata?.description || "",
      cutLengthMm: round3(cutLengthMm),
      billedLengthMm: round3(billedLengthMm),
      pieceQuantity: round3(pieceQuantity),
      kgm: round3(kgm),
      adjustment: round2(adjustment),
      ratePerKg,
      weightKg,
      amount,
    });
  });

  (schedule?.lines || []).filter((line) => line.itemType === "hardware").forEach((line) => {
    const hardware = hardwareByCode.get(String(line.sapCode || "").trim().toUpperCase());
    if (!hardware) {
      warnings.push(`Hardware ${line.sapCode || line.description || "unknown"} was not found`);
      return;
    }
    const quantity = Math.max(0, toNumber(evaluateFormula(line.quantityFormula || "1", variables)));
    const configured = Number(hardwarePricing[hardware.subCategory]);
    const adjustment = Number.isFinite(configured) && configured !== 0 ? configured : DEFAULT_PROFILE_ADJUSTMENT;
    const unitRate = round2(toNumber(hardware.rate) + adjustment);
    const amount = round2(quantity * unitRate);
    materialValue += amount;
    otherMaterials.push({ type: "Hardware", sapCode: line.sapCode, quantity, unitRate, amount });
  });

  const linkedHardware = resolveLinkedHardware({
    config: hardwareLinkingConfig,
    glassSpec: item.glassSpec,
    widthMm: width,
    heightMm: height,
    hardwareOpeningType: item.hardwareOpeningType,
  });
  linkedHardware.lines.forEach((line) => {
    const hardware = hardwareByCode.get(String(line.sapCode || "").trim().toUpperCase());
    if (!hardware) {
      warnings.push(`Linked hardware ${line.sapCode || line.description || "unknown"} was not found`);
      return;
    }
    const configured = Number(hardwarePricing[hardware.subCategory]);
    const adjustment = Number.isFinite(configured) && configured !== 0 ? configured : DEFAULT_PROFILE_ADJUSTMENT;
    const unitRate = round2(toNumber(hardware.rate) + adjustment);
    const amount = round2(line.quantity * unitRate);
    materialValue += amount;
    otherMaterials.push({ type: "Hardware", sapCode: line.sapCode, description: line.description, quantity: line.quantity, unitRate, amount });
  });

  const addLinkedProfile = (type, line, quantity, useStockRounding) => {
    const code = String(line.sapCode || "").trim().toUpperCase();
    const metadata = profileMetadataByCode.get(code) || productsByCode.get(code);
    if (!metadata) {
      warnings.push(`${type} ${line.sapCode || line.description || "unknown"} was not found`);
      return;
    }
    const requiredLengthMm = toNumber(evaluateFormula(line.formula || "0", variables));
    const stockLengthMm = toNumber(metadata.length);
    const billedQuantity = useStockRounding && stockLengthMm > 0
      ? Math.ceil(requiredLengthMm / stockLengthMm)
      : Math.max(0, toNumber(quantity, 1));
    const unitRate = round2(metadata.configuredRate);
    const amount = round2(billedQuantity * unitRate);
    materialValue += amount;
    otherMaterials.push({ type, sapCode: line.sapCode, quantity: billedQuantity, unitRate, amount });
  };
  (glassBeadingConfig?.beadings || []).forEach((line) => addLinkedProfile("Beading", line, line.quantity, false));
  (glassBeadingConfig?.gaskets || []).forEach((line) => addLinkedProfile("Gasket", line, 1, true));

  materialValue = round2(materialValue);
  totalWeightKg = round3(totalWeightKg);
  if (!profiles.length) {
    throw new Error("Cutting schedule contains no priceable profile entries");
  }
  return {
    baseRate: round2(materialValue / area),
    materialValue,
    area: round3(area),
    totalWeightKg,
    profiles,
    otherMaterials,
    warnings,
  };
};

const calculateJoinMaterialRate = ({
  item,
  lines,
  productsByCode,
  profileMetadataByCode,
  profilePricing,
  nalcoPrice,
}) => {
  const variables = {
    W: toNumber(item.width),
    H: toNumber(item.height),
    AREA: toNumber(item.area),
    Q: 1,
  };
  const profiles = [];
  const warnings = [];
  let materialValue = 0;
  let totalWeightKg = 0;

  if (!Array.isArray(lines) || !lines.length) {
    warnings.push(`${item.joinType || "Join"} pricing is not configured for ${item.series || "this series"}; excluded from rate`);
  } else {
    lines.forEach((line) => {
      const code = String(line.sapCode || "").trim().toUpperCase();
      const metadata = profileMetadataByCode.get(code) || productsByCode.get(code);
      if (!metadata) {
        warnings.push(`${item.joinType || "Join"} profile ${line.sapCode || "unknown"} was not found; excluded from rate`);
        return;
      }
      const lengthMm = toNumber(evaluateFormula(line.formula || "H", variables)) + CUT_ALLOWANCE_MM;
      const weightKg = round3((lengthMm / 1000) * toNumber(metadata.kgm) * Math.max(1, toNumber(line.quantity, 1)));
      const ratePerKg = round2(nalcoPrice / 1000 + resolveProfileAdjustment(profilePricing, metadata));
      const amount = round2(weightKg * ratePerKg);
      materialValue += amount;
      totalWeightKg += weightKg;
      profiles.push({ sapCode: line.sapCode, weightKg, ratePerKg, amount });
    });
  }

  return {
    baseRate: toNumber(item.area) > 0 ? round2(materialValue / toNumber(item.area)) : 0,
    materialValue: round2(materialValue),
    area: toNumber(item.area),
    totalWeightKg: round3(totalWeightKg),
    profiles,
    otherMaterials: [],
    warnings,
  };
};

const calculateQuotationItemRates = async ({ items, userId }) => {
  const sourceItems = Array.isArray(items) ? items : [];
  if (!sourceItems.length) throw new Error("At least one item is required");

  const regularItems = sourceItems.filter((item) => item.itemType !== "join");
  const joinItems = sourceItems.filter((item) => item.itemType === "join");
  const configFilters = regularItems.map((item) => ({
    systemType: String(item.systemType || ""),
    series: String(item.series || ""),
    description: String(item.description || ""),
  }));
  const [configs, glassBeadingConfigs, hardwareLinkingConfigs, mullionConfigs, products, hardware, profileOptions, user, nalcoPrice] = await Promise.all([
    CuttingScheduleConfig.find({ $or: configFilters }).lean(),
    GlassBeadingConfig.find({ $or: configFilters }).lean(),
    HardwareLinkingConfig.find({ $or: configFilters }).lean(),
    MullionCouplerConfig.find(
      joinItems.length
        ? { $or: joinItems.map((item) => ({ systemType: item.systemType, series: item.series })) }
        : { _id: null }
    ).lean(),
    Product.find({ enabled: true }).lean(),
    Hardware.find({}).lean(),
    ProfileOptions.findOne({}).lean(),
    userId ? User.findById(userId).select("dynamicPricing").lean() : null,
    getLatestNalcoPrice(),
  ]);
  if (nalcoPrice <= 0) throw new Error("Latest NALCO price is unavailable");

  const configMap = new Map(configs.map((config) => [
    `${config.systemType}||${config.series}||${config.description}`,
    config,
  ]));
  const productsByCode = new Map(products.map((product) => [
    String(product.sapCode || "").trim().toUpperCase(),
    product,
  ]));
  const profileMetadataByCode = buildProfileMetadataMap(profileOptions);
  const profilePricing = restoreRateMap(user?.dynamicPricing?.profiles || {});
  const hardwarePricing = restoreRateMap(user?.dynamicPricing?.hardware || {});
  const hardwareByCode = new Map(hardware.map((row) => [String(row.sapCode || "").trim().toUpperCase(), row]));
  const glassConfigMap = new Map(glassBeadingConfigs.map((config) => [
    `${config.systemType}||${config.series}||${config.description}||${config.glassSpec}`,
    config,
  ]));
  const hardwareLinkingMap = new Map(hardwareLinkingConfigs.map((config) => [
    `${config.systemType}||${config.series}||${config.description}`, config,
  ]));
  const mullionConfigMap = new Map(mullionConfigs.map((config) => [`${config.systemType}||${config.series}`, config]));

  return sourceItems.map((item) => {
    if (item.itemType === "join") {
      const config = mullionConfigMap.get(`${item.systemType}||${item.series}`);
      const configuredLines = item.joinType === "Mullion" ? config?.mullions : config?.couplers;
      const lines = getJoinPricingLines(configuredLines, item.joinOrientation);
      return {
        clientId: String(item.clientId || "__joins__"),
        ...calculateJoinMaterialRate({
          item,
          lines,
          productsByCode,
          profileMetadataByCode,
          profilePricing,
          nalcoPrice,
        }),
        nalcoPrice,
        nalcoRatePerKg: round2(nalcoPrice / 1000),
        calculatedAt: new Date().toISOString(),
        calculationVersion: 2,
      };
    }
    const config = configMap.get(`${item.systemType}||${item.series}||${item.description}`);
    if (!config) throw new Error(`Cutting schedule is not configured for ${item.description}`);
    const key = scheduleKeyForItem(item);
    const schedule = findSchedule(config, key);
    if (!schedule) throw new Error(`Cutting schedule variant ${key} is not configured for ${item.description}`);
    return {
      clientId: String(item.clientId || item.id || ""),
      ...calculateProfileMaterialBaseRate({
        item,
        schedule,
        productsByCode,
        profileMetadataByCode,
        profilePricing,
        hardwareByCode,
        hardwarePricing,
        glassBeadingConfig: glassConfigMap.get(`${item.systemType}||${item.series}||${item.description}||${item.glassSpec || ""}`),
        hardwareLinkingConfig: hardwareLinkingMap.get(`${item.systemType}||${item.series}||${item.description}`),
        nalcoPrice,
      }),
      nalcoPrice,
      nalcoRatePerKg: round2(nalcoPrice / 1000),
      calculatedAt: new Date().toISOString(),
      calculationVersion: 1,
    };
  });
};

module.exports = {
  calculateQuotationItemRates,
  __test: {
    calculateProfileMaterialBaseRate,
    calculateJoinMaterialRate,
    getJoinPricingLines,
    resolveProfileAdjustment,
    scheduleKeyForItem,
  },
};
