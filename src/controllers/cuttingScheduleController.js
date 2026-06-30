const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const CuttingScheduleConfig = require("../models/Quotation/CuttingScheduleConfig");
const OptionSet = require("../models/Quotation/OptionSet");
const Quotation = require("../models/Quotation/Quotation");
const Series = require("../models/Quotation/Series");
const User = require("../models/User");
const UserOptionSet = require("../models/Quotation/UserOptionSet");
const { closePdfBrowser, launchPdfBrowser, setPdfContent } = require("../utils/pdfBrowser");
const { getOrGeneratePdf } = require("../utils/pdfCache");
const { restoreRateMap } = require("../utils/rateMapUtils");
const { hydrateQuotationItems } = require("../utils/quotationItems");
const {
  catalogProductKey,
  escapeHtml,
  evaluateFormula,
  listProfileProducts,
  resolveCatalogProducts,
  round3,
  searchCatalogProducts,
  toNumber,
} = require("../utils/cuttingSchedule");

const BOM_DEFAULT_ADJUSTMENT = 100;

const CUTTING_SCHEDULE_KEYS = [
  { key: "45_45", horizontalAngle: "45", verticalAngle: "45" },
  { key: "45_90", horizontalAngle: "45", verticalAngle: "90" },
  { key: "90_45", horizontalAngle: "90", verticalAngle: "45" },
  { key: "90_90", horizontalAngle: "90", verticalAngle: "90" },
];

const isCuttingScheduleKey = (value) =>
  CUTTING_SCHEDULE_KEYS.some((schedule) => schedule.key === value);

const normalizeAngle = (value, fallback = "90") => {
  const text = String(value || "").replace(/[^\d]/g, "");
  return text === "45" || text === "90" ? text : fallback;
};

const makeScheduleKey = (horizontalAngle, verticalAngle) =>
  `${normalizeAngle(horizontalAngle)}_${normalizeAngle(verticalAngle)}`;

const emptySchedules = () =>
  CUTTING_SCHEDULE_KEYS.map((schedule) => ({
    ...schedule,
    lines: [],
  }));

const getDescriptionCatalog = async (_req, res) => {
  try {
    const series = await Series.find({})
      .populate("system", "name")
      .sort({ name: 1 })
      .lean();

    const configs = await CuttingScheduleConfig.find({}).lean();
    const configMap = configs.reduce((acc, config) => {
      acc[`${config.systemType}||${config.series}||${config.description}`] = config;
      return acc;
    }, {});

    const descriptions = series.flatMap((seriesItem) =>
      (seriesItem.descriptions || []).map((description) => {
        const systemType = seriesItem.system?.name || "";
        const key = `${systemType}||${seriesItem.name}||${description.name}`;
        const config = configMap[key];
        const lineCount = getConfiguredLineCount(config);
        return {
          systemType,
          series: seriesItem.name,
          description: description.name,
          configId: config?._id,
          lineCount,
          configured: lineCount > 0,
        };
      })
    );

    res.json({ descriptions });
  } catch (error) {
    console.error("getDescriptionCatalog error", error);
    res.status(500).json({ message: "Unable to fetch cutting schedule descriptions" });
  }
};

const listConfigs = async (_req, res) => {
  try {
    const configs = await CuttingScheduleConfig.find({})
      .sort({ systemType: 1, series: 1, description: 1 })
      .lean();
    res.json({ configs });
  } catch (error) {
    console.error("listConfigs error", error);
    res.status(500).json({ message: "Unable to fetch cutting schedule configs" });
  }
};

const getConfig = async (req, res) => {
  try {
    const config = await CuttingScheduleConfig.findById(req.params.id).lean();
    if (!config) return res.status(404).json({ message: "Cutting schedule config not found" });
    res.json({ config });
  } catch (error) {
    console.error("getConfig error", error);
    res.status(500).json({ message: "Unable to fetch cutting schedule config" });
  }
};

const normalizeLineType = (value) =>
  value === "hardware" || value === "glass" ? value : "profile";

const normalizeLine = (line = {}, index = 0) => {
  const itemType = normalizeLineType(line.itemType);
  return {
    itemType,
    sapCode: String(line.sapCode || "").trim(),
    description: String(line.description || "").trim(),
    quantityFormula: String(line.quantityFormula || "1").trim(),
    dimensionFormula:
      itemType === "hardware" ? "" : String(line.dimensionFormula || "").trim(),
    cutAngle:
      itemType === "hardware" || itemType === "glass"
        ? ""
        : String(line.cutAngle || line.cutAngleLeft || line.cutAngleRight || "").trim(),
    position: String(line.position || "").trim(),
    unit: String(line.unit || (itemType === "glass" ? "Sqft" : "Pcs")).trim(),
    sortOrder: Number.isFinite(Number(line.sortOrder)) ? Number(line.sortOrder) : index,
  };
};

const normalizeGlassBeadingLinks = (links = []) =>
  (Array.isArray(links) ? links : [])
    .map((link) => ({
      glassSpec: String(link.glassSpec || "").trim(),
      beadingSapCode: String(link.beadingSapCode || "").trim(),
      beadingDescription: String(link.beadingDescription || "").trim(),
    }))
    .filter((link) => link.glassSpec);

const normalizeSchedules = (schedules = [], legacyLines = []) => {
  const byKey = new Map(
    (Array.isArray(schedules) ? schedules : []).map((schedule) => [
      schedule.key,
      schedule,
    ])
  );

  return emptySchedules().map((baseSchedule) => {
    const source = byKey.get(baseSchedule.key);
    const lines =
      Array.isArray(source?.lines) && source.lines.length
        ? source.lines
        : baseSchedule.key === "90_90" && legacyLines.length
          ? legacyLines
          : [];

    return {
      ...baseSchedule,
      lines: lines.map(normalizeLine),
    };
  });
};

const getConfiguredLineCount = (config = {}) => {
  const scheduleCount = (config.schedules || []).reduce(
    (total, schedule) => total + (schedule.lines?.length || 0),
    0
  );
  return scheduleCount || config.lines?.length || 0;
};

const findScheduleLines = (config, scheduleKey) => {
  const schedules = normalizeSchedules(config?.schedules || [], config?.lines || []);
  const selected = schedules.find((schedule) => schedule.key === scheduleKey);

  return {
    key: scheduleKey,
    horizontalAngle: selected?.horizontalAngle || scheduleKey.split("_")[0],
    verticalAngle: selected?.verticalAngle || scheduleKey.split("_")[1],
    lines: selected?.lines || [],
  };
};

const getItemScheduleKey = (item, config) => {
  const explicitKey = String(item?.cuttingScheduleKey || item?.scheduleKey || "").trim();
  if (isCuttingScheduleKey(explicitKey)) return explicitKey;

  const horizontalAngle = item?.frameCutAngle || item?.cutAngleHorizontal || item?.hCutAngle;
  const verticalAngle = item?.shutterCutAngle || item?.cutAngleVertical || item?.vCutAngle;
  if (horizontalAngle || verticalAngle) {
    return makeScheduleKey(horizontalAngle, verticalAngle);
  }

  return isCuttingScheduleKey(config?.defaultScheduleKey) ? config.defaultScheduleKey : "90_90";
};

const upsertConfig = async (req, res) => {
  try {
    const legacyLines = Array.isArray(req.body.lines) ? req.body.lines.map(normalizeLine) : [];
    const schedules = normalizeSchedules(req.body.schedules, legacyLines);
    const payload = {
      systemType: String(req.body.systemType || "").trim(),
      series: String(req.body.series || "").trim(),
      description: String(req.body.description || "").trim(),
      notes: String(req.body.notes || "").trim(),
      lines: schedules.find((schedule) => schedule.key === "90_90")?.lines || [],
      schedules,
      glassBeadingLinks: normalizeGlassBeadingLinks(req.body.glassBeadingLinks),
      defaultScheduleKey: isCuttingScheduleKey(req.body.defaultScheduleKey)
        ? req.body.defaultScheduleKey
        : "90_90",
    };

    if (!payload.systemType || !payload.series || !payload.description) {
      return res.status(400).json({ message: "systemType, series and description are required" });
    }

    if (
      payload.schedules.some((schedule) =>
        schedule.lines.some((line) => line.itemType !== "glass" && !line.sapCode)
      )
    ) {
      return res.status(400).json({ message: "Every profile and hardware line needs a SAP code" });
    }
    if (
      payload.schedules.some(
        (schedule) => schedule.lines.filter((line) => line.itemType === "glass").length > 2
      )
    ) {
      return res.status(400).json({ message: "Each cutting schedule can have only two glass line" });
    }
    if (
      payload.schedules.some(
        (schedule) =>
          schedule.lines.length > 0 &&
          schedule.lines.filter((line) => line.itemType === "glass").length !== 2
      )
    ) {
      return res.status(400).json({ message: "Each configured cutting schedule needs exactly two glass line" });
    }
    if (
      payload.schedules.some((schedule) =>
        schedule.lines.some((line) => line.itemType === "glass" && !line.dimensionFormula)
      )
    ) {
      return res.status(400).json({ message: "Glass lines need a dimension formula" });
    }

    const config = await CuttingScheduleConfig.findOneAndUpdate(
      {
        systemType: payload.systemType,
        series: payload.series,
        description: payload.description,
      },
      payload,
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    res.json({ message: "Cutting schedule config saved", config });
  } catch (error) {
    console.error("upsertConfig error", error);
    res.status(500).json({ message: "Unable to save cutting schedule config", error: error.message });
  }
};

const deleteConfig = async (req, res) => {
  try {
    const config = await CuttingScheduleConfig.findByIdAndDelete(req.params.id);
    if (!config) return res.status(404).json({ message: "Cutting schedule config not found" });
    res.json({ message: "Cutting schedule config deleted" });
  } catch (error) {
    console.error("deleteConfig error", error);
    res.status(500).json({ message: "Unable to delete cutting schedule config" });
  }
};

const searchCatalog = async (req, res) => {
  try {
    const sapCode = String(req.query.sapCode || "").trim();
    const itemType = req.query.itemType === "hardware" ? "hardware" : "profile";
    if (!sapCode) return res.json({ products: [], product: null });

    const products = await searchCatalogProducts({ itemType, sapCode, limit: 12 });
    res.json({ products, product: products[0] || null });
  } catch (error) {
    console.error("searchCatalog error", error);
    res.status(500).json({ message: "Unable to search SAP code" });
  }
};

const getBeadingCatalog = async (_req, res) => {
  try {
    const products = await listProfileProducts();
    res.json({ products });
  } catch (error) {
    console.error("getBeadingCatalog error", error);
    res.status(500).json({ message: "Unable to fetch beading catalog" });
  }
};

const itemRowsForSchedule = (quotation) => {
  const rows = [];
  (quotation.items || []).forEach((item) => {
    if (item.systemType === "Combination" && Array.isArray(item.subItems) && item.subItems.length) {
      item.subItems.forEach((subItem) => rows.push({ ...subItem, parentRefCode: item.refCode }));
      return;
    }
    rows.push(item);
  });
  return rows;
};

const uniqueConfigKeys = (items) =>
  Array.from(
    new Map(
      items.map((item) => {
        const key = `${item.systemType || ""}||${item.series || ""}||${item.description || ""}`;
        return [
          key,
          {
            systemType: item.systemType || "",
            series: item.series || "",
            description: item.description || "",
          },
        ];
      })
    ).values()
  );

const configCatalogLines = (configs) =>
  configs.flatMap((config) => [
    ...(config.lines || []),
    ...(config.schedules || []).flatMap((schedule) => schedule.lines || []),
    ...(config.glassBeadingLinks || []).map((link) => ({
      itemType: "profile",
      sapCode: link.beadingSapCode,
    })),
  ]);

const findLinkedBeading = (links = [], glassSpec = "") => {
  const selectedGlass = String(glassSpec || "").trim();
  if (!selectedGlass) return null;

  return (Array.isArray(links) ? links : []).find(
    (link) =>
      String(link.glassSpec || "").trim().toLowerCase() === selectedGlass.toLowerCase() &&
      String(link.beadingSapCode || "").trim()
  );
};

const round2 = (value) => {
  const n = toNumber(value);
  return Math.round(n * 100) / 100;
};

const formatMoney = (value) =>
  new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(round2(value));

const currency = (value) => `₹${formatMoney(value)}`;

const readAssetDataUrl = (relativePath, mimeType) => {
  const candidates = [
    path.resolve(__dirname, "../../../glazia-frontend/public", relativePath),
    path.resolve(__dirname, "../../../Glazia-Windoors/frontend/public", relativePath),
    path.resolve(__dirname, "../../../../glazia-frontend/public", relativePath),
    path.resolve(__dirname, "../../../frontend/public", relativePath),
    path.resolve(process.cwd(), "../glazia-frontend/public", relativePath),
    path.resolve(process.cwd(), "../frontend/public", relativePath),
    path.resolve(process.cwd(), "frontend/public", relativePath),
  ];

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        return `data:${mimeType};base64,${fs.readFileSync(filePath).toString("base64")}`;
      }
    } catch (_error) {
      // Ignore missing optional PDF assets.
    }
  }

  return "";
};

const numberToWordsIndian = (amount) => {
  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const underHundred = (n) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`);
  const underThousand = (n) =>
    `${n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? " " : ""}` : ""}${n % 100 ? underHundred(n % 100) : ""}`;
  const n = Math.round(toNumber(amount));
  if (!n) return "Zero Rupees Only";

  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  const parts = [];
  if (crore) parts.push(`${underThousand(crore)} Crore`);
  if (lakh) parts.push(`${underThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${underThousand(thousand)} Thousand`);
  if (rest) parts.push(underThousand(rest));
  return `${parts.join(" ")} Rupees Only`;
};

const normalizeDynamicMap = (input) => restoreRateMap(input || {});

const getDynamicAdjustment = (pricing = {}, keys = []) => {
  for (const key of keys) {
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(pricing, key)) {
      const value = toNumber(pricing[key], BOM_DEFAULT_ADJUSTMENT);
      return value === 0 ? BOM_DEFAULT_ADJUSTMENT : value;
    }
  }
  return BOM_DEFAULT_ADJUSTMENT;
};

const getLatestNalcoPrice = async () => {
  try {
    const schema = new mongoose.Schema(
      {
        nalcoPrice: Number,
        date: Date,
      },
      { collection: "nalcos" }
    );
    const Nalco = mongoose.models.nalco || mongoose.model("nalco", schema);
    const latest = await Nalco.findOne({}).sort({ date: -1 }).lean();
    return toNumber(latest?.nalcoPrice);
  } catch (_error) {
    return 0;
  }
};

const getUserPricingContext = async (userId) => {
  const [user, glassAdminDoc, glassUserDoc, nalcoPrice] = await Promise.all([
    userId ? User.findById(userId).select("dynamicPricing").lean() : null,
    OptionSet.findOne({ type: "glassSpec", system: { $exists: false } }).lean(),
    userId ? UserOptionSet.findOne({ user: userId, type: "glassSpec" }).lean() : null,
    getLatestNalcoPrice(),
  ]);

  return {
    nalcoPrice,
    dynamicPricing: {
      hardware: normalizeDynamicMap(user?.dynamicPricing?.hardware),
      profiles: normalizeDynamicMap(user?.dynamicPricing?.profiles),
    },
    glassRates: {
      ...restoreRateMap(glassAdminDoc?.values),
      ...restoreRateMap(glassUserDoc?.values),
    },
  };
};

const getProfileAdjustment = (product, context) => {
  const categoryName = String(product?.catalogCategory || "").trim();
  const optionName = String(product?.catalogOption || "").trim();
  return getDynamicAdjustment(context.dynamicPricing.profiles, [
    categoryName && optionName ? `${categoryName} - ${optionName}` : "",
    categoryName && optionName ? `${categoryName}-${optionName}` : "",
    categoryName,
  ]);
};

const getHardwareAdjustment = (product, context) =>
  getDynamicAdjustment(context.dynamicPricing.hardware, [product?.subCategory]);

const addBomRow = (groups, row) => {
  const key = [
    row.type,
    row.itemCode,
    row.description,
    row.unit,
    round2(row.rate),
    row.measureLabel || "",
  ].join("||");

  if (!groups.has(key)) {
    groups.set(key, {
      ...row,
      quantity: 0,
      amount: 0,
    });
  }

  const existing = groups.get(key);
  existing.quantity = round3(existing.quantity + toNumber(row.quantity));
  existing.amount = round2(existing.amount + toNumber(row.amount));
};

const buildBomData = async (quotation) => {
  const sourceItems = itemRowsForSchedule(quotation);
  const keys = uniqueConfigKeys(sourceItems);

  const [configs, pricingContext] = await Promise.all([
    CuttingScheduleConfig.find({
      $or: keys.length ? keys : [{ systemType: "__none__" }],
    }).lean(),
    getUserPricingContext(quotation.user),
  ]);

  const configMap = configs.reduce((acc, config) => {
    acc[`${config.systemType}||${config.series}||${config.description}`] = config;
    return acc;
  }, {});
  const catalogProducts = await resolveCatalogProducts(configCatalogLines(configs));

  const groups = new Map();
  const notes = [];

  for (const item of sourceItems) {
    const key = `${item.systemType || ""}||${item.series || ""}||${item.description || ""}`;
    const config = configMap[key];
    const schedule = config ? findScheduleLines(config, getItemScheduleKey(item, config)) : null;
    if (!schedule?.lines?.length) continue;

    const itemQuantity = Math.max(1, toNumber(item.quantity, 1));
    const variables = {
      W: toNumber(item.width),
      H: toNumber(item.height),
      Q: itemQuantity,
      AREA: toNumber(item.area),
    };

    for (const line of schedule.lines) {
      const qty = evaluateFormula(line.quantityFormula || "1", variables);
      let dimension = "";
      if (
        (line.itemType === "profile" || line.itemType === "glass") &&
        line.dimensionFormula
      ) {
        if (line.dimensionFormula.includes(",")) {
          const [d1, d2] = line.dimensionFormula.split(",");

          const val1 = evaluateFormula(d1.trim(), variables);
          const val2 = evaluateFormula(d2.trim(), variables);

          dimension = `${val1} x ${val2}`;
        } else {
          dimension = evaluateFormula(line.dimensionFormula, variables);
        }
      }

      if (line.itemType === "profile") {
        const product = catalogProducts.get(catalogProductKey(line));
        const adjustment = getProfileAdjustment(product, pricingContext);
        const rate = round2(toNumber(pricingContext.nalcoPrice) / 1000 + adjustment);
        const lengthMm = toNumber(dimension, toNumber(product?.length, 0));
        const weightKg = round3(qty * (lengthMm / 1000) * toNumber(product?.kgm, 0));
        addBomRow(groups, {
          type: "Profile",
          description: line.description || product?.label || line.sapCode,
          itemCode: line.sapCode,
          quantity: qty,
          unit: "Pcs",
          measureLabel: `${round3(lengthMm)} mm / ${weightKg} kg`,
          rate,
          amount: rate * weightKg,
        });
        continue;
      }

      if (line.itemType === "hardware") {
        const product = catalogProducts.get(catalogProductKey(line));
        const rate = product
          ? round2(toNumber(product.rate) + getHardwareAdjustment(product, pricingContext))
          : 0;
        addBomRow(groups, {
          type: "Hardware",
          description: line.description || product?.label || line.sapCode,
          itemCode: line.sapCode,
          quantity: qty,
          unit: line.unit || product?.system || "Pcs",
          measureLabel: "",
          rate,
          amount: rate * qty,
        });
        continue;
      }

      if (line.itemType === "glass") {
        const glassSpec = String(item.glassSpec || "").trim();
        const linkedBeading = findLinkedBeading(config?.glassBeadingLinks, glassSpec);
        const notePrefix = `${item.refCode || item.location || item.description || "Item"}`;

        if (!linkedBeading) {
          notes.push(`${notePrefix}: Beading not set for glass "${glassSpec || "-"}" by admin.`);
          continue;
        }

        const glassArea = round3(toNumber(item.area) * qty);
        const glassRate = round2(toNumber(pricingContext.glassRates[glassSpec]));
        addBomRow(groups, {
          type: "Glass",
          description: glassSpec || "Glass",
          itemCode: glassSpec || "-",
          quantity: glassArea,
          unit: "Sqft",
          measureLabel: dimension === "" ? "" : `${round3(dimension)} mm`,
          rate: glassRate,
          amount: glassRate * glassArea,
        });

        const beadingLine = {
          itemType: "profile",
          sapCode: linkedBeading.beadingSapCode,
        };
        const beadingProduct = catalogProducts.get(catalogProductKey(beadingLine));
        const adjustment = getProfileAdjustment(beadingProduct, pricingContext);
        const rate = round2(toNumber(pricingContext.nalcoPrice) / 1000 + adjustment);
        const lengthMm = toNumber(dimension, toNumber(beadingProduct?.length, 0));
        const weightKg = round3(qty * (lengthMm / 1000) * toNumber(beadingProduct?.kgm, 0));
        addBomRow(groups, {
          type: "Profile",
          description:
            linkedBeading.beadingDescription ||
            beadingProduct?.label ||
            linkedBeading.beadingSapCode,
          itemCode: linkedBeading.beadingSapCode,
          quantity: qty,
          unit: "Pcs",
          measureLabel: `${round3(lengthMm)} mm / ${weightKg} kg`,
          rate,
          amount: rate * weightKg,
        });
      }
    }
  }

  const rows = Array.from(groups.values()).sort((a, b) =>
    `${a.type} ${a.description} ${a.itemCode}`.localeCompare(
      `${b.type} ${b.description} ${b.itemCode}`
    )
  );

  const totals = rows.reduce(
    (acc, row) => {
      acc[row.type] = round2((acc[row.type] || 0) + row.amount);
      acc.grand = round2(acc.grand + row.amount);
      return acc;
    },
    { Profile: 0, Hardware: 0, Glass: 0, grand: 0 }
  );

  return {
    quotation,
    project: quotation.customerDetails?.name || "-",
    projectCode: quotation.generatedId || quotation.quotationDetails?.id || String(quotation._id),
    customer: quotation.customerDetails || {},
    generatedAt: new Date(),
    nalcoPrice: pricingContext.nalcoPrice,
    rows,
    totals,
    notes,
  };
};

const buildScheduleData = async (quotation) => {
  const sourceItems = itemRowsForSchedule(quotation);
  const keys = uniqueConfigKeys(sourceItems);

  const configs = await CuttingScheduleConfig.find({
    $or: keys.length ? keys : [{ systemType: "__none__" }],
  }).lean();

  const configMap = configs.reduce((acc, config) => {
    acc[`${config.systemType}||${config.series}||${config.description}`] = config;
    return acc;
  }, {});
  const catalogProducts = await resolveCatalogProducts(configCatalogLines(configs));

  const sections = [];
  for (const item of sourceItems) {
    const key = `${item.systemType || ""}||${item.series || ""}||${item.description || ""}`;
    const config = configMap[key];
    const schedule = config ? findScheduleLines(config, getItemScheduleKey(item, config)) : null;
    const quantity = Math.max(1, toNumber(item.quantity, 1));
    const variables = {
      W: toNumber(item.width),
      H: toNumber(item.height),
      Q: quantity,
      AREA: toNumber(item.area),
    };
    const rows = [];
    const notes = [];

    for (const line of schedule?.lines || []) {
      const catalogProduct = catalogProducts.get(catalogProductKey(line));
      const qty = evaluateFormula(line.quantityFormula || "1", variables);
      let dimension = "";
      if (
        (line.itemType === "profile" || line.itemType === "glass") &&
        line.dimensionFormula
      ) {
        if (line.dimensionFormula.includes(",")) {
          const [d1, d2] = line.dimensionFormula.split(",");

          const val1 = evaluateFormula(d1.trim(), variables);
          const val2 = evaluateFormula(d2.trim(), variables);

          dimension = `${val1} x ${val2}`;
        } else {
          dimension = evaluateFormula(line.dimensionFormula, variables);
        }
      }
      const glassSpec = String(item.glassSpec || "").trim();
      const linkedBeading =
        line.itemType === "glass" ? findLinkedBeading(config?.glassBeadingLinks, glassSpec) : null;

      // if (line.itemType === "glass" && !linkedBeading) {
      //   notes.push(`Beading not set for glass "${glassSpec || "-"}" by admin.`);
      //   continue;
      // }
      rows.push({
        itemType: line.itemType,
        description:
          line.itemType === "glass"
            ?
            // linkedBeading.beadingDescription || line.description ||
            glassSpec || "Glass beading"
            : line.description || catalogProduct?.label || line.sapCode,
        sapCode: line.itemType === "glass" ? "--" : line.sapCode,
        dimension,
        cutAngle: line.cutAngle || line.cutAngleLeft || line.cutAngleRight || "",
        quantity: qty,
        unit: line.unit || "Pcs",
        position: line.position || "",
        sortOrder: line.sortOrder || 0,
        linkedBeading,
      });
    }

    const sortedRows = rows.sort((a, b) => a.sortOrder - b.sortOrder);
    if (!sortedRows.length && !notes.length) {
      continue;
    }

    sections.push({
      item,
      configFound: Boolean(config),
      scheduleKey: schedule?.key || "",
      horizontalAngle: schedule?.horizontalAngle || "",
      verticalAngle: schedule?.verticalAngle || "",
      rows: sortedRows,
      notes,
    });
  }

  return {
    quotation,
    project: quotation.customerDetails?.name || "-",
    projectCode: quotation.generatedId || quotation.quotationDetails?.id || String(quotation._id),
    generatedAt: new Date(),
    sections,
  };
};

const renderRows = (rows) =>
  rows.length
    ? rows
      .map(
        (row) => `
        <tr>
          <td>${escapeHtml(row.itemType === "profile" ? "Profile" : row.itemType === "glass" ? "Glass" : "Fabrication Hardware")}</td>
          <td>${escapeHtml(row.description)}</td>
           <td>${escapeHtml(row.itemType === "glass" ? "--" : row.sapCode)}</td> 
          <td class="num">${row.dimension === "" ? "" : escapeHtml(round3(row.dimension))}</td>
          <td class="num">${escapeHtml(row.cutAngle)}</td>
          <td class="num">${escapeHtml(row.quantity)}</td>
          <td>${escapeHtml(row.unit)}</td>
          <td>${escapeHtml(row.position)}</td>
        </tr>
      `
      )
      .join("")
    : '<tr><td colspan="8" class="empty">No cutting schedule items to show.</td></tr>';

const renderNotes = (notes = []) =>
  notes.length
    ? `<div class="schedule-notes">${notes.map((note) => `<div>${escapeHtml(note)}</div>`).join("")}</div>`
    : "";

const buildPdfHtml = (data) => {
  const date = data.generatedAt.toLocaleDateString("en-IN");
  const time = data.generatedAt.toLocaleTimeString("en-IN");

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          @page { size: A4; margin: 8mm; }
          * { box-sizing: border-box; }
          body { font-family: Arial, sans-serif; color: #050505; margin: 0; font-size: 11px; }
          .header { display: flex; justify-content: space-between; align-items: flex-start; border-top: 2px solid #111; padding: 14px 4px 8px; }
          h1 { margin: 0; font-size: 24px; }
          .meta { text-align: right; font-size: 15px; line-height: 1.35; }
          .project { display: flex; justify-content: space-between; border: 1px solid #999; border-bottom: 0; padding: 5px; font-size: 14px; font-weight: 700; }
          .section { page-break-inside: avoid; margin-bottom: 12px; }
          .tech { width: 100%; border-collapse: collapse; border: 1px solid #999; }
          .tech td { border: 1px solid #999; padding: 3px 5px; vertical-align: top; }
          .tech .label { width: 110px; font-weight: 700; }
          .thumb { width: 230px; text-align: center; }
          .thumb img { max-width: 210px; max-height: 145px; object-fit: contain; }
          .thumb .placeholder { height: 120px; display: flex; align-items: center; justify-content: center; color: #666; }
          .schedule { width: 100%; border-collapse: collapse; border: 1px solid #888; }
          .schedule th, .schedule td { border: 1px solid #999; padding: 5px; vertical-align: top; }
          .schedule th { background: #91cef0; font-size: 12px; }
          .bar { background: #91cef0; border: 1px solid #999; border-top: 0; padding: 6px; font-size: 16px; font-weight: 700; }
          .num { text-align: center; white-space: nowrap; }
          .empty { padding: 12px; text-align: center; color: #666; }
          .schedule-notes { border: 1px solid #999; border-top: 0; padding: 5px 6px; color: #8a4b00; font-size: 10px; }
          .no-data { border: 1px solid #999; padding: 16px; text-align: center; color: #666; font-size: 13px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Production Report</h1>
          <div class="meta">Date : ${escapeHtml(date)}<br>${escapeHtml(time)}<br>+05:30</div>
        </div>
        <div class="project">
          <div>Project : ${escapeHtml(data.project)}</div>
          <div>Project Code : ${escapeHtml(data.projectCode)}</div>
        </div>
        ${data.sections.length
      ? data.sections
        .map((section, index) => {
          const item = section.item;
          const image = item.refImage
            ? `<img src="${escapeHtml(item.refImage)}" alt="${escapeHtml(item.refCode || "")}" />`
            : `<div class="placeholder">No Image</div>`;
          return `
              <div class="section">
                <table class="tech">
                  <tr>
                    <td rowspan="12" class="num">${index + 1}.</td>
                    <td class="label">Design Ref</td>
                    <td>${escapeHtml(item.refCode || "-")}</td>
                    <td rowspan="12" class="thumb"><div>View From Inside</div>${image}</td>
                  </tr>
                  <tr><td class="label">Typology Loc</td><td>${escapeHtml(item.location || "-")}</td></tr>
                  <tr><td class="label">Dimension</td><td>W = ${escapeHtml(item.width || 0)}; H = ${escapeHtml(item.height || 0)}</td></tr>
                  <tr><td class="label">Quantity</td><td>${escapeHtml(item.quantity || 1)}</td></tr>
                  <tr><td class="label">Typology type</td><td>${escapeHtml(item.systemType || "-")}</td></tr>
                  <tr><td class="label">Series</td><td>${escapeHtml(item.series || "-")}</td></tr>
                  <tr><td class="label">Description</td><td>${escapeHtml(item.description || "-")}</td></tr>
                  <tr><td class="label">Cut Angles</td><td>H = ${escapeHtml(section.horizontalAngle || "-")}°; V = ${escapeHtml(section.verticalAngle || "-")}°</td></tr>
                  <tr><td class="label">Profile Finish</td><td>${escapeHtml(item.colorFinish || "-")}</td></tr>
                  <tr><td class="label">Handle</td><td>${escapeHtml([item.handleType, item.handleColor].filter(Boolean).join(", ") || "-")}</td></tr>
                  <tr><td class="label">Mesh</td><td>${escapeHtml(item.meshPresent ? item.meshType || "Yes" : "No")}</td></tr>
                </table>
                <div class="bar">Fabrication</div>
                <table class="schedule">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Description</th>
                      <th>Item Code</th>
                      <th>Dimension (mm)</th>
                      <th>Cut Angle</th>
                      <th>Qty</th>
                      <th>Unit</th>
                      <th>Position</th>
                    </tr>
                  </thead>
                  <tbody>${renderRows(section.rows)}</tbody>
                </table>
                ${renderNotes(section.notes)}
              </div>
            `;
        })
        .join("")
      : '<div class="no-data">No cutting schedule formulas are configured for the selected products and cut angle combinations.</div>'}
      </body>
    </html>
  `;
};

const renderBomRows = (rows = []) =>
  rows.length
    ? rows
      .map(
        (row, index) => `
          <tr>
            <td style="text-align:center;">${index + 1}</td>
            <td>${escapeHtml(row.itemCode)}</td>
            <td>
              ${escapeHtml(row.description)}
              ${row.measureLabel ? `<div class="muted tiny">${escapeHtml(row.measureLabel)}</div>` : ""}
            </td>
            <td>${escapeHtml(row.type)}</td>
            <td style="text-align:center;">${escapeHtml(row.quantity)}</td>
            <td style="text-align:right;">${currency(row.rate)}</td>
            <td style="text-align:center;">${escapeHtml(row.unit || "Piece")}</td>
            <td style="text-align:right;">${currency(row.amount)}</td>
          </tr>
        `
      )
      .join("")
    : '<tr><td colspan="8" class="empty">No BOM items to show.</td></tr>';

const buildBomPdfHtml = (data) => {
  const invoiceDateParts = data.generatedAt
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    .split(" ");
  const invoiceDate = `${invoiceDateParts[0]} ${invoiceDateParts[1]}, ${invoiceDateParts[2]}`;
  const referenceNumber = String(data.projectCode || "").replace(/[^a-zA-Z0-9]/g, "") || "BOM";
  const invoiceNumber = `GW/${String(data.generatedAt.getFullYear()).slice(-2)}/${String(
    data.generatedAt.getMonth() + 1
  ).padStart(2, "0")}/BOM-${referenceNumber}`;
  const customer = data.customer || {};
  const destination = [customer.city, customer.state].filter(Boolean).join(", ") || "Destination";
  const subtotal = round2(data.totals.grand);
  const gstHalf = round2(subtotal * 0.09);
  const gstTotal = round2(gstHalf * 2);
  const net = round2(subtotal + gstTotal);
  const roundedNet = Math.round(net);
  const totalQuantity = data.rows.reduce((sum, row) => sum + toNumber(row.quantity), 0);
  const logoSrc = readAssetDataUrl("Logo.svg", "image/svg+xml");
  const upiSrc = readAssetDataUrl("upi.jpeg", "image/jpeg");
  const notesHtml = data.notes.length
    ? `<div class="payment-info">
        <div class="label">Notes</div>
        <div class="divider" style="margin: 10px 0 12px;"></div>
        <div class="terms">${data.notes.map((note) => escapeHtml(note)).join("<br/>")}</div>
      </div>`
    : "";

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; font-family: Arial, sans-serif; color: #1a1a1a; }
          .container { width: 100%; max-width: 780px; margin: 0 auto; padding: 28px 30px 36px; background: #fff; }
          .top-row { display: flex; justify-content: space-between; align-items: flex-start; }
          .logo-img { max-width: 160px; max-height: 54px; object-fit: contain; }
          .logo-text { font-size: 36px; font-weight: 700; letter-spacing: 2px; }
          .title { color: #d92525; font-size: 18px; font-weight: 700; letter-spacing: 0.5px; margin-top: 6px; }
          .muted { color: #404040; line-height: 1.5; font-size: 12px; }
          .tiny { font-size: 10px; margin-top: 2px; }
          .label { font-weight: 700; font-size: 12px; color: #111; }
          .divider { border-bottom: 1px solid #b8b8b8; margin: 14px 0 18px; }
          table { width: 100%; border-collapse: collapse; }
          .info-table th { text-align: left; font-size: 12px; font-weight: 700; padding: 4px 8px; }
          .info-table td { font-size: 12px; padding: 4px 8px 10px; color: #404040; }
          .info-table { margin-bottom: 6px; }
          .address-table td { width: 50%; vertical-align: top; padding: 4px 8px 10px; }
          .products thead th {
            font-size: 12px;
            font-weight: 700;
            padding: 10px 8px;
            text-align: left;
            border-bottom: 1px solid #111;
          }
          .products thead th:nth-child(1),
          .products tbody td:nth-child(1),
          .products thead th:nth-child(5),
          .products tbody td:nth-child(5),
          .products thead th:nth-child(7),
          .products tbody td:nth-child(7) { text-align: center; }
          .products thead th:nth-child(6),
          .products tbody td:nth-child(6),
          .products thead th:nth-child(8),
          .products tbody td:nth-child(8) { text-align: right; }
          .products tbody td {
            font-size: 12px;
            padding: 10px 8px;
            border-bottom: 1px solid #d8d8d8;
            vertical-align: top;
          }
          .products tbody tr:last-child td { border-bottom: 1px solid #111; }
          .products tbody td:last-child { white-space: nowrap; }
          .totals-table td { font-size: 12px; padding: 6px 0; }
          .totals-table td:last-child { text-align: right; font-weight: 700; }
          .totals-table tr:last-child td { border-top: 1px solid #b8b8b8; padding-top: 10px; }
          .payment-grid { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 28px; }
          .payment-info { margin-top: 24px; }
          .qr-img { width: 105px; height: 105px; border: 1px solid #cfcfcf; border-radius: 6px; object-fit: contain; background: #f7f7f7; padding: 6px; }
          .terms { font-size: 12px; line-height: 1.6; color: #2a2a2a; }
          .empty { padding: 14px; text-align: center; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="top-row">
            ${logoSrc ? `<img src="${logoSrc}" alt="Glazia Logo" class="logo-img">` : `<div class="logo-text">GLAZIA</div>`}
            <div class="title">BILL OF MATERIALS</div>
          </div>

          <div class="divider"></div>

          <table class="info-table">
            <tr>
              <td>
                <div class="label">Glazia Windoors Pvt. Ltd.</div>
                <div class="muted">Khata No. 361, Rect. No. 21 4/70,<br/>
                Kherki Dhaula Village Road,<br/>
                Gurgaon, Haryana - 122001<br/>India</div>
              </td>
              <td style="text-align: right;">
                <div class="label">Contact</div>
                <div class="muted">www.glazia.in<br/>+91-9958053708<br/>sales@glazia.com</div>
              </td>
            </tr>
          </table>

          <div class="divider"></div>

          <table class="info-table">
            <tr>
              <th>Invoice #</th>
              <th>Invoice Date</th>
              <th>Reference #</th>
              <th>Dispatch Mode</th>
              <th>Destination</th>
            </tr>
            <tr>
              <td>${escapeHtml(invoiceNumber)}</td>
              <td>${escapeHtml(invoiceDate)}</td>
              <td>${escapeHtml(referenceNumber)}</td>
              <td>By Road</td>
              <td>${escapeHtml(destination)}</td>
            </tr>
          </table>

          <div class="divider"></div>

          <table class="address-table">
            <tr>
              <td>
                <div class="label">Invoice To:</div>
                <div class="muted">${escapeHtml(customer.name || data.project || "Glazia Windoors Pvt. Ltd.")},<br/>
                ${escapeHtml(customer.address || "Gurgaon, Haryana - 122001")}<br/>
                ${escapeHtml([customer.city, customer.state].filter(Boolean).join(", "))}${customer.pincode ? ` - ${escapeHtml(customer.pincode)}` : ""}</div>
              </td>
              <td>
                <div class="label">Shipped To:</div>
                <div class="muted">${escapeHtml(customer.name || data.project || "Glazia Windoors Pvt. Ltd.")},<br/>
                ${escapeHtml(customer.address || "Gurgaon, Haryana - 122001")}<br/>
                ${escapeHtml([customer.city, customer.state].filter(Boolean).join(", "))}${customer.pincode ? ` - ${escapeHtml(customer.pincode)}` : ""}</div>
              </td>
            </tr>
          </table>

          <div class="divider"></div>

          <table class="products">
            <thead>
              <tr>
                <th style="width: 5%;">#</th>
                <th style="width: 15%;">SAP Code</th>
                <th style="width: 24%;">Description</th>
                <th style="width: 15%;">Series</th>
                <th style="width: 8%;">Qty.</th>
                <th style="width: 12%;">Rate(₹)</th>
                <th style="width: 8%;">Per</th>
                <th style="width: 13%;">Amt. (₹)</th>
              </tr>
            </thead>
            <tbody>
              ${renderBomRows(data.rows)}
              <tr>
                <td></td>
                <td></td>
                <td></td>
                <td style="font-weight: 700; text-align: center;">Total</td>
                <td style="text-align: center; font-weight: 700;">${round3(totalQuantity)}</td>
                <td></td>
                <td></td>
                <td style="text-align: right; font-weight: 700;">${currency(subtotal)}</td>
              </tr>
            </tbody>
          </table>

          <div class="divider"></div>

          <div class="payment-grid">
            <div>
              <div class="label">Payment Method</div>
              <div class="muted">Bank Transfer</div>

              <div style="margin-top: 10px;">
                <div class="label">Rounded Off Amount</div>
                <div class="muted">${currency(roundedNet)}</div>
              </div>

              <div style="margin-top: 12px;">
                <div class="label">In Words</div>
                <div class="muted">${escapeHtml(numberToWordsIndian(roundedNet))}</div>
              </div>

              <div style="margin-top: 12px;">
                <div class="label">NALCO Price Used</div>
                <div class="muted">${currency(toNumber(data.nalcoPrice) / 1000)} / Kg</div>
              </div>
            </div>
            <div>
              <table class="totals-table">
                <tr>
                  <td class="label">Sub Total</td>
                  <td>${currency(subtotal)}</td>
                </tr>
                <tr>
                  <td class="label">SGST@9%</td>
                  <td>${currency(gstHalf)}</td>
                </tr>
                <tr>
                  <td class="label">CGST@9%</td>
                  <td>${currency(gstHalf)}</td>
                </tr>
                <tr>
                  <td class="label">Total</td>
                  <td>${currency(net)}</td>
                </tr>
              </table>
            </div>
          </div>

          <div class="payment-info">
            <div class="label">Payment Info</div>
            <div class="divider" style="margin: 10px 0 12px;"></div>
            <table class="info-table" style="margin-bottom: 0;">
              <tr>
                <td style="width: 60%; vertical-align: top;">
                  <div class="muted"><span class="label">Account No: </span>50200084871361</div>
                  <div class="muted"><span class="label">Account Name: </span>AGlazia Windoors Pvt. Ltd.</div>
                  <div class="muted"><span class="label">IFSC Code: </span>HDFC0004809</div>
                  <div class="muted"><span class="label">Bank: </span>HDFC Bank</div>
                </td>
                <td style="text-align: right; vertical-align: top;">
                  <div style="display: inline-flex; gap: 12px; align-items: flex-start;">
                    ${upiSrc ? `<img src="${upiSrc}" alt="Glazia UPI QR" class="qr-img" />` : ""}
                    <div>
                      <div class="muted"><span class="label">Name: </span>Glazia Windoors Pvt. Ltd.</div>
                      <div class="muted"><span class="label">UPI: </span>glazia@okhdfcbank</div>
                    </div>
                  </div>
                </td>
              </tr>
            </table>
          </div>

          ${notesHtml}

          <div class="divider" style="margin: 18px 0 12px;"></div>

          <div class="label" style="text-align: center; margin-bottom: 10px;">Terms & Conditions</div>
          <div class="terms">
            1. PI Validity Period<br/>
            &nbsp;&nbsp;a. 15 days from date of issuance irrespective of selling price.<br/>
            &nbsp;&nbsp;b. PI shall be treated as null and void in all respect in absence of advance payment as per PI items.<br/><br/>
            2. Selling Price<br/>
            &nbsp;&nbsp;Selling Price is governed by NALCO Billet price on the date of material dispatch.<br/><br/>
            3. Supply Schedule<br/>
            &nbsp;&nbsp;Supply Schedule will be discussed and finalized after advance payment.<br/><br/>
            4. Advance Payment<br/>
            &nbsp;&nbsp;a. 100% advance for PI having value Rs. &gt;0 ~ =&gt; 2,00,000<br/>
            &nbsp;&nbsp;b. 50% advance for PI having value Rs. &gt;0 ~ =&lt; 2,00,000<br/><br/>
            5. Transportation<br/>
            &nbsp;&nbsp;In customer scope, no claim or responsibility in any form related to transportation will be levied.
          </div>
        </div>
      </body>
    </html>
  `;
};

const renderCuttingSchedulePdfBuffer = async (quotation) => {
  let browserHandle;
  let page;
  try {
    const data = await buildScheduleData(quotation);
    const html = buildPdfHtml(data);
    browserHandle = await launchPdfBrowser();
    page = await browserHandle.browser.newPage();
    await setPdfContent(page, html);
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "8mm", right: "8mm", bottom: "8mm", left: "8mm" },
      preferCSSPageSize: true,
    });
  } finally {
    if (page && !page.isClosed()) await page.close();
    await closePdfBrowser(browserHandle);
  }
};

const generateCuttingSchedulePdf = async (req, res) => {
  try {
    const { id } = req.params;
    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { generatedId: id }] }
      : { generatedId: id };

    const quotation = await Quotation.findOne(query).lean();
    if (!quotation) return res.status(404).json({ message: "Quotation not found" });

    if (
      req.user?.role !== "admin" &&
      quotation.user &&
      req.user?.userId &&
      quotation.user.toString() !== req.user.userId
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { buffer: pdfBuffer, cacheStatus } = await getOrGeneratePdf({
      quotation,
      type: "cutting-schedule",
      generate: async () =>
        renderCuttingSchedulePdfBuffer(await hydrateQuotationItems(quotation)),
    });

    const projectCode = quotation.generatedId || quotation.quotationDetails?.id || String(quotation._id);
    const fileName = `${projectCode || "quotation"}-cutting-schedule.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("X-PDF-Cache", cacheStatus);
    return res.end(pdfBuffer);
  } catch (error) {
    console.error("generateCuttingSchedulePdf error", error);
    if (error.code === "ENOSPC") {
      return res.status(507).json({
        message: "Server does not have enough free disk space to generate cutting schedule PDF",
        error: error.message,
      });
    }
    res.status(500).json({ message: "Failed to generate cutting schedule PDF", error: error.message });
  }
};

const findQuotationForUser = async (req, res, hydrate = true) => {
  const { id } = req.params;
  const query = mongoose.Types.ObjectId.isValid(id)
    ? { $or: [{ _id: id }, { generatedId: id }] }
    : { generatedId: id };

  let quotation = await Quotation.findOne(query).lean();
  if (!quotation) {
    res.status(404).json({ message: "Quotation not found" });
    return null;
  }

  if (
    req.user?.role !== "admin" &&
    quotation.user &&
    req.user?.userId &&
    quotation.user.toString() !== req.user.userId
  ) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }

  return hydrate ? hydrateQuotationItems(quotation) : quotation;
};

const renderBomPdfBuffer = async (quotation) => {
  let browserHandle;
  let page;
  try {
    const data = await buildBomData(quotation);
    const html = buildBomPdfHtml(data);
    browserHandle = await launchPdfBrowser();
    page = await browserHandle.browser.newPage();
    await setPdfContent(page, html);
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "7.62mm", right: "7.62mm", bottom: "7.62mm", left: "7.62mm" },
      preferCSSPageSize: true,
    });
  } finally {
    if (page && !page.isClosed()) await page.close();
    await closePdfBrowser(browserHandle);
  }
};

const generateBomPdf = async (req, res) => {
  try {
    const quotation = await findQuotationForUser(req, res, false);
    if (!quotation) return null;

    const { buffer: pdfBuffer, cacheStatus } = await getOrGeneratePdf({
      quotation,
      type: "bom",
      generate: async () => renderBomPdfBuffer(await hydrateQuotationItems(quotation)),
    });

    const projectCode = quotation.generatedId || quotation.quotationDetails?.id || String(quotation._id);
    const fileName = `${projectCode || "quotation"}-bom.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("X-PDF-Cache", cacheStatus);
    return res.end(pdfBuffer);
  } catch (error) {
    console.error("generateBomPdf error", error);
    if (error.code === "ENOSPC") {
      return res.status(507).json({
        message: "Server does not have enough free disk space to generate BOM PDF",
        error: error.message,
      });
    }
    res.status(500).json({ message: "Failed to generate BOM PDF", error: error.message });
    return null;
  }
};

module.exports = {
  deleteConfig,
  getBeadingCatalog,
  generateBomPdf,
  generateCuttingSchedulePdf,
  renderBomPdfBuffer,
  renderCuttingSchedulePdfBuffer,
  getConfig,
  getDescriptionCatalog,
  listConfigs,
  searchCatalog,
  upsertConfig,
};
