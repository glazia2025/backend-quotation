const mongoose = require("mongoose");
const Quotation = require("../models/Quotation/Quotation");
const User = require("../models/User");
const System = require("../models/Quotation/System");
const Series = require("../models/Quotation/Series");
const OptionSet = require("../models/Quotation/OptionSet");
const AreaSlab = require("../models/Quotation/AreaSlab");
const BaseRate = require("../models/Quotation/BaseRate");
const HandleRule = require("../models/Quotation/HandleRule");
const HandleOption = require("../models/Quotation/HandleOption");
const UserOptionSet = require("../models/Quotation/UserOptionSet");
const UserDescriptionRate = require("../models/Quotation/UserDescriptionRate");
const jwt = require("jsonwebtoken");
const { extractAuthToken } = require("../utils/authCookies");
const { closePdfBrowser, launchPdfBrowser } = require("../utils/pdfBrowser");
const { colorMapToArray } = require("../utils/handleOptionUtils");

const numberOr = (value, fallback = 0) => {
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : fallback;
};

const unique = (list) => Array.from(new Set(list.filter(Boolean)));

const toBooleanFlag = (value) => {
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return Boolean(value);
};

const { restoreRateMap } = require("../utils/rateMapUtils");

const mapToArray = (map) => {
  const restored = restoreRateMap(map);
  return Object.entries(restored).map(([name, rate]) => ({
    name,
    rate: numberOr(rate, 0),
  }));
};

const effectiveRateWithAdminFallback = (adminRate, userRate) => {
  const parsedUserRate = Number(userRate);
  if (!Number.isFinite(parsedUserRate) || parsedUserRate === 0) {
    return numberOr(adminRate, 0);
  }
  return parsedUserRate;
};

const getOptionalUserId = (req) => {
  try {
    const token = extractAuthToken(req);
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret");
    return decoded?.userId || null;
  } catch (_error) {
    return null;
  }
};

const buildQuotationPrefix = (name = "") => {
  const compact = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  const initials = (compact.slice(0, 2) || "XX").padEnd(2, "X");
  return `QU${initials}`;
};

const getNextQuotationId = async (userId) => {
  let name = "";
  if (userId) {
    const user = await User.findById(userId).select("name").lean();
    name = user?.name || "";
  }

  const prefix = buildQuotationPrefix(name);
  console.log("prefix", prefix);
  const latest = await Quotation.findOne({
    "generatedId": new RegExp(`^${prefix}`),
  })
    .sort({ createdAt: -1 })
    .select({ "generatedId": 1 })
    .lean();

  console.log("latest", latest);

  const lastId = latest?.generatedId || "";
  const suffix = Number(lastId.slice(prefix.length));
  const nextValue = Number.isFinite(suffix) && suffix > 0 ? suffix + 1 : 1;
  const nextSuffix = String(nextValue).padStart(3, "0");

  return `${prefix}${nextSuffix}`;
};

const fetchOptionValues = async (type, systemDoc) => {
  if (type === "colorFinish" || type === "meshType" || type === "glassSpec") {
    const globalOption = await OptionSet.findOne({ type, system: { $exists: false } }).lean();
    return mapToArray(globalOption?.values);
  }

  if (systemDoc) {
    const optionSet = await OptionSet.findOne({ type, system: systemDoc._id }).lean();
    if (optionSet?.values) return mapToArray(optionSet.values);
  }
  const globalOption = await OptionSet.findOne({ type, system: { $exists: false } }).lean();
  return mapToArray(globalOption?.values);
};

const pickHandleRule = (rules, systemType, series, description) => {
  if (!rules?.length) return null;
  const exact = rules.find(
    (r) => r.description === description && r.systemType === systemType && r.series === series
  );
  if (exact) return exact;
  const systemMatch = rules.find(
    (r) => r.description === description && r.systemType === systemType && !r.series
  );
  if (systemMatch) return systemMatch;
  const generic = rules.find(
    (r) => r.description === description && !r.systemType && !r.series
  );
  return generic || null;
};

const resolveHandleInfo = (description, seriesMeta, rules, systemType, series) => {
  if (seriesMeta) {
    const matched = seriesMeta.descriptions?.find(
      (item) => item.name === description
    );
    if (matched) {
      return {
        types: matched.handleTypes || [],
        count: numberOr(matched.handleCount, 0),
      };
    }
  }

  const rule = pickHandleRule(rules, systemType, series, description);
  if (rule) {
    return {
      types: rule.handleTypes || [],
      count: numberOr(rule.handleCount, 0),
    };
  }

  return { types: [], count: 0 };
};

const getAreaSlabsSorted = async () => {
  const slabs = await AreaSlab.find({}).sort({ order: 1, max: 1 }).lean();
  if (slabs.length >= 3) return slabs.slice(0, 3);
  const defaults = [
    { label: "Small", max: 10 },
    { label: "Medium", max: 20 },
    { label: "Large", max: Number.MAX_SAFE_INTEGER },
  ];
  return [...slabs, ...defaults.slice(slabs.length, 3)];
};

const resolveAreaSlabIndex = (area, slabs) => {
  const safeArea = numberOr(area, 0);
  const slab = slabs.find((item) => safeArea <= item.max);
  if (slab) return slabs.indexOf(slab);
  return slabs.length ? slabs.length - 1 : 0;
};

const resolveBaseRate = async (systemType, series, description, area) => {
  const slabs = await getAreaSlabsSorted();
  const baseRateDoc = await BaseRate.findOne({ systemType, series, description }).lean();
  const areaIndex = Math.min(resolveAreaSlabIndex(area, slabs), 2);
  const rates = Array.isArray(baseRateDoc?.rates)
    ? [...baseRateDoc.rates, 0, 0, 0].slice(0, 3)
    : [0, 0, 0];
  const baseRate = rates[areaIndex] ?? 0;

  return { baseRate, areaIndex, slabs: slabs.slice(0, 3) };
};

const getSystems = async (req, res) => {
  try {
    const systems = await System.find({}, "name").sort({ name: 1 }).lean();
    res.json({ systems: systems.map((item) => item.name) });
  } catch (error) {
    console.error("Error fetching systems:", error);
    res.status(500).json({ message: "Error fetching system list" });
  }
};

const getSeries = async (req, res) => {
  const { systemType } = req.params;
  if (!systemType) {
    return res.status(400).json({ message: "systemType is required" });
  }

  try {
    const systemDoc = await System.findOne({ name: systemType }).lean();
    const seriesFromDb = await Series.find(
      systemDoc ? { system: systemDoc._id } : {},
      "name"
    ).lean();
    const seriesFromRates = await BaseRate.find(
      { systemType },
      "series"
    ).lean();

    const series = unique([
      ...seriesFromDb.map((item) => item.name),
      ...seriesFromRates.map((item) => item.series),
    ]);

    res.json({ series });
  } catch (error) {
    console.error("Error fetching series:", error);
    res.status(500).json({ message: "Error fetching series list" });
  }
};

const getDescriptions = async (req, res) => {
  const { systemType, series } = req.params;
  if (!systemType || !series) {
    return res
      .status(400)
      .json({ message: "systemType and series are required" });
  }

  try {
    const userId = getOptionalUserId(req);
    const systemDoc = await System.findOne({ name: systemType }).lean();
    const seriesDoc = await Series.findOne(
      systemDoc ? { name: series, system: systemDoc._id } : { name: series }
    )
      .populate("system", "name")
      .lean();

    console.log('systemDoc, seriesDoc', systemDoc, seriesDoc);
    const rateDocs = await BaseRate.find(
      { systemType, series },
      "description rates"
    ).lean();

    const userRateDocs = userId
      ? await UserDescriptionRate.find(
        { user: userId, systemType, series },
        "description rates"
      ).lean()
      : [];

    console.log('rateDescriptions', rateDocs);

    const dbDescriptions = (seriesDoc?.descriptions || []).map(
      (item) => item.name
    );

    const descriptionList = unique([
      ...dbDescriptions,
      ...rateDocs.map((item) => item.description),
      ...userRateDocs.map((item) => item.description),
    ]);

    const handleRules = await HandleRule.find({
      description: { $in: descriptionList },
    }).lean();

    const rateMap = rateDocs.reduce((acc, doc) => {
      acc[doc.description] = doc.rates || [];
      return acc;
    }, {});

    const userRateMap = userRateDocs.reduce((acc, doc) => {
      acc[doc.description] = doc.rates || [];
      return acc;
    }, {});

    const descriptions = descriptionList.map((item) => {
      const handleInfo = resolveHandleInfo(
        item,
        seriesDoc,
        handleRules,
        systemType,
        series
      );
      const adminRates = Array.isArray(rateMap[item]) ? rateMap[item] : [0, 0, 0];
      const userRates = Array.isArray(userRateMap[item]) ? userRateMap[item] : [0, 0, 0];
      const effectiveRates = [0, 1, 2].map((idx) =>
        effectiveRateWithAdminFallback(adminRates[idx], userRates[idx])
      );
      return {
        name: item,
        handleTypes: handleInfo.types,
        defaultHandleCount: handleInfo.count,
        baseRates: effectiveRates,
      };
    });

    res.json({ descriptions });
  } catch (error) {
    console.error("Error fetching descriptions:", error);
    res.status(500).json({ message: "Error fetching description list" });
  }
};

const getOptionLists = async (req, res) => {
  const { systemType } = req.query;

  try {
    const userId = getOptionalUserId(req);
    const [colorFinishes, meshTypes, glassSpecs] = await Promise.all([
      fetchOptionValues("colorFinish", null),
      fetchOptionValues("meshType", null),
      fetchOptionValues("glassSpec", null),
    ]);

    const userOptionSets = userId
      ? await UserOptionSet.find({
        user: userId,
        type: { $in: ["colorFinish", "meshType", "glassSpec"] },
      }).lean()
      : [];

    console.log('userOptionSets', userOptionSets);

    const userOptionMap = userOptionSets.reduce((acc, row) => {
      acc[row.type] = restoreRateMap(row.values);
      return acc;
    }, {});

    console.log('userOptionMap', userOptionMap);

    const mergeAdminAndUserRates = (adminItems, type) => {
      const adminMap = adminItems.reduce((acc, row) => {
        acc[row.name] = numberOr(row.rate, 0);
        return acc;
      }, {});
      const userMap = userOptionMap[type] || {};
      const names = unique([...Object.keys(adminMap), ...Object.keys(userMap)]).sort();
      return names.map((name) => ({
        name,
        rate: Object.prototype.hasOwnProperty.call(adminMap, name)
          ? effectiveRateWithAdminFallback(adminMap[name], userMap[name])
          : numberOr(userMap[name], 0),
      }));
    };

    const handleOptions = systemType
      ? await HandleOption.find({
        systemType,
        $or: [
          { createdBy: { $exists: false } },
          { createdBy: null },
          ...(userId ? [{ createdBy: userId }] : []),
        ],
      }).lean()
      : [];

    res.json({
      colorFinishes: mergeAdminAndUserRates(colorFinishes, "colorFinish"),
      meshTypes: mergeAdminAndUserRates(meshTypes, "meshType"),
      glassSpecs: mergeAdminAndUserRates(glassSpecs, "glassSpec"),
      handleOptions: handleOptions.map((h) => ({
        name: h.name,
        colors: colorMapToArray(h.colors),
      })),
    });
  } catch (error) {
    console.error("Error fetching option lists:", error);
    res.status(500).json({ message: "Error fetching option lists" });
  }
};

const previewRate = async (req, res) => {
  const {
    systemType,
    series,
    description,
    width,
    height,
    area: areaFromBody,
    quantity = 1,
  } = req.body;

  if (!systemType || !series || !description) {
    return res.status(400).json({
      message: "systemType, series and description are required to calculate",
    });
  }

  const computedArea =
    numberOr(areaFromBody, 0) || numberOr(width, 0) * numberOr(height, 0);
  const { baseRate, areaIndex, slabs } = await resolveBaseRate(
    systemType,
    series,
    description,
    computedArea
  );

  const handleRules = await HandleRule.find({ description }).lean();
  const handleInfo = resolveHandleInfo(
    description,
    null,
    handleRules,
    systemType,
    series
  );

  const amount = baseRate * (computedArea || 1) * numberOr(quantity, 1);

  res.json({
    rate: baseRate,
    amount,
    area: computedArea,
    areaSlabIndex: areaIndex,
    slabs,
    handleInfo: {
      types: handleInfo.types,
      defaultHandleCount: handleInfo.count,
    },
  });
};

const createQuotation = async (req, res) => {
  const {
    breakdown,
    items = [],
    customerDetails = {},
    quotationDetails = {},
    globalConfig = {},
  } = req.body;

  try {
    const generatedId = await getNextQuotationId(req.user?.userId);
    console.log('generatedId', generatedId);
    const quotation = await Quotation.create({
      user: req.user?.userId,
      items,
      customerDetails,
      quotationDetails: {
        ...quotationDetails
      },

      generatedId,

      globalConfig,
      breakdown,
    });

    res.status(201).json({ quotation });
  } catch (error) {
    console.error("Error creating quotation:", error);
    res.status(500).json({ message: "Error creating quotation" });
  }
};
const listQuotations = async (req, res) => {
  const { systemType, series, description, page = 1, limit = 20 } = req.query;

  const filter = {};
  if (req.user?.role !== "admin") filter.user = req.user?.userId;

  if (systemType) filter.systemType = systemType;
  if (series) filter.series = series;
  if (description) filter.description = description;

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const skip = (pageNum - 1) * limitNum;

  try {
    const [quotations, total] = await Promise.all([
      Quotation.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .select("_id user customerDetails quotationDetails breakdown generatedId createdAt updatedAt items.amount") // keep list light
        .lean(),
      Quotation.countDocuments(filter),
    ]);
    const quotationsWithTotals = quotations.map((quotation) => {
      const storedTotal = numberOr(quotation?.breakdown?.totalAmount);
      if (storedTotal > 0) return quotation;

      const itemTotal = Array.isArray(quotation.items)
        ? quotation.items.reduce((sum, item) => sum + numberOr(item?.amount), 0)
        : 0;

      return {
        ...quotation,
        breakdown: {
          ...(quotation.breakdown || {}),
          totalAmount: itemTotal,
        },
      };
    });

    res.json({
      quotations: quotationsWithTotals,
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (error) {
    console.error("Error fetching quotations:", error);
    res.status(500).json({ message: "Error fetching quotations" });
  }
};

const getQuotationById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid quotation id" });
    }

    const quotation = await Quotation.findById(req.params.id).lean();
    if (!quotation) {
      return res.status(404).json({ message: "Quotation not found" });
    }

    if (
      req.user?.role !== "admin" &&
      quotation.user &&
      req.user?.userId &&
      quotation.user.toString() !== req.user.userId
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    res.json({ quotation });
  } catch (error) {
    console.error("Error fetching quotation:", error);
    res.status(500).json({ message: "Error fetching quotation" });
  }
};

const updateQuotationById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid quotation id" });
    }

    const quotation = await Quotation.findById(req.params.id).lean();
    if (!quotation) {
      return res.status(404).json({ message: "Quotation not found" });
    }

    const {
      breakdown,
      items = [],
      customerDetails = {},
      quotationDetails = {},
      globalConfig = {},
    } = req.body;

    const updatedQuotation = await Quotation.findByIdAndUpdate(
      req.params.id,
      {
        items,
        customerDetails,
        quotationDetails,
        globalConfig,
        breakdown,
      },
      { new: true, runValidators: true }
    );

    res.json({ updatedQuotation });
  } catch (error) {
    console.error("Error fetching quotation:", error);
    res.status(500).json({ message: "Error fetching quotation" });
  }
};
const deleteQuotationById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid quotation id" });
    }
    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return res.status(404).json({ message: "Quotation not found" });
    }
    // Role based check
    if (
      req.user?.role !== "admin" &&
      quotation.user.toString() !== req.user.userId
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }
    await Quotation.findByIdAndDelete(id);
    res.json({ message: "Quotation deleted successfully" });
  } catch (error) {
    console.error("Delete quotation error:", error);
    res.status(500).json({ message: "Error deleting quotation" });
  }
};

const COMBINATION_SYSTEM = "Combination";

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function booleanOr(value, fallback = true) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    return value.toLowerCase() !== "false";
  }
  return Boolean(value);
}

function escapeHtml(value) {
  return safeString(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nl2br(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function formatCurrency(value) {
  return toNumber(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return safeString(value, "-");
  return d.toLocaleDateString("en-IN");
}

function mmToSqft(width, height) {
  const w = toNumber(width);
  const h = toNumber(height);
  if (!w || !h) return 0;
  return (w * h) / (304.8 * 304.8);
}

function computeArea(item) {
  const area = toNumber(item?.area);
  if (area > 0) return area;

  const width = toNumber(item?.width);
  const height = toNumber(item?.height);

  if (width > 0 && height > 0) {
    return Number(mmToSqft(width, height).toFixed(3));
  }

  return 0;
}

function computeAmount(item) {
  const amount = toNumber(item?.amount);
  if (amount > 0) return amount;

  const area = computeArea(item);
  const rate = toNumber(item?.rate);
  const quantity = toNumber(item?.quantity, 1);

  return Number((area * rate * quantity).toFixed(2));
}

function addProfit(value, profitPercentage) {
  return Number((toNumber(value) * (1 + toNumber(profitPercentage) / 100)).toFixed(2));
}

function addProfitToItemValues(item, profitPercentage) {
  return {
    ...item,
    rate: addProfit(item.rate, profitPercentage),
    amount: addProfit(item.amount, profitPercentage),
    subItems: Array.isArray(item.subItems)
      ? item.subItems.map((subItem) => addProfitToItemValues(subItem, profitPercentage))
      : [],
  };
}

function boolToDisplay(value) {
  return value ? "Yes" : "No";
}

function formatHandle(handleType, handleColor) {
  const type = safeString(handleType);
  if (!type || type === "-") return "-";

  const color = safeString(handleColor);
  return color && color !== "-" ? `${type} / ${color}` : type;
}

function formatMesh(meshPresent, meshType) {
  const present = safeString(meshPresent, "No");
  const type = safeString(meshType);
  return present === "Yes" && type && type !== "-" ? `${present} (${type})` : present;
}

function normalizeImage(value) {
  const img = safeString(value);

  if (!img) return "";

  if (
    img.startsWith("data:image/") ||
    img.startsWith("http://") ||
    img.startsWith("https://")
  ) {
    return img;
  }

  return `data:image/png;base64,${img}`;
}

function normalizeSubItem(subItem) {
  return {
    refCode: safeString(subItem?.refCode, "-"),
    location: safeString(subItem?.location, "-"),
    width: toNumber(subItem?.width),
    height: toNumber(subItem?.height),
    area: computeArea(subItem),
    systemType: safeString(subItem?.systemType, "-"),
    series: safeString(subItem?.series, "-"),
    description: safeString(subItem?.description, "-"),
    colorFinish: safeString(subItem?.colorFinish, "-"),
    glassSpec: safeString(subItem?.glassSpec, "-"),
    handleType: safeString(subItem?.handleType, "-"),
    handleColor: safeString(subItem?.handleColor, "-"),
    handleCount: toNumber(subItem?.handleCount),
    meshPresent: boolToDisplay(!!subItem?.meshPresent),
    meshType: safeString(subItem?.meshType, "-"),
    rate: toNumber(subItem?.rate),
    quantity: toNumber(subItem?.quantity, 1),
    amount: computeAmount(subItem),
    refImage: normalizeImage(subItem?.refImage),
    remarks: safeString(subItem?.remarks, "-"),
  };
}

function normalizeItem(item) {
  const normalizedSubItems = Array.isArray(item?.subItems)
    ? item.subItems.map(normalizeSubItem)
    : [];

  const systemType = safeString(item?.systemType, "-");

  return {
    refCode: safeString(item?.refCode, "-"),
    location: safeString(item?.location, "-"),
    width: toNumber(item?.width),
    height: toNumber(item?.height),
    area: computeArea(item),
    systemType,
    series: safeString(item?.series, "-"),
    description: safeString(item?.description, "-"),
    colorFinish: safeString(item?.colorFinish, "-"),
    glassSpec: safeString(item?.glassSpec, "-"),
    handleType: safeString(item?.handleType, "-"),
    handleColor: safeString(item?.handleColor, "-"),
    handleCount: toNumber(item?.handleCount),
    meshPresent: boolToDisplay(!!item?.meshPresent),
    meshType: safeString(item?.meshType, "-"),
    rate: toNumber(item?.rate),
    quantity: toNumber(item?.quantity, 1),
    amount: computeAmount(item),
    refImage: normalizeImage(item?.refImage),
    remarks: safeString(item?.remarks, "-"),
    isCombination:
      systemType.toLowerCase() === COMBINATION_SYSTEM.toLowerCase(),
    subItems: normalizedSubItems,
  };
}

function computeTotals(items, additionalCosts = {}, profitPercentage = 0) {
  const baseTotal = items.reduce((sum, item) => sum + toNumber(item.amount), 0);
  const totalArea = items.reduce(
    (sum, item) => sum + toNumber(item.area) * Math.max(1, toNumber(item.quantity, 1)),
    0
  );
  const totalQty = items.reduce(
    (sum, item) => sum + Math.max(1, toNumber(item.quantity, 1)),
    0
  );

  const profitPercent = toNumber(profitPercentage);
  const profitValue = (baseTotal * profitPercent) / 100;
  const itemsSubtotal = baseTotal + profitValue;
  const installationCost = totalArea * toNumber(additionalCosts.installation);
  const transportCost = toNumber(additionalCosts.transport);
  const loadingUnloadingCost = toNumber(additionalCosts.loadingUnloading);
  const discountPercent = toNumber(additionalCosts.discountPercent);
  const beforeDiscount =
    itemsSubtotal + installationCost + transportCost + loadingUnloadingCost;
  const discountValue = (beforeDiscount * discountPercent) / 100;
  const totalProjectCost = beforeDiscount - discountValue;
  const gstValue = totalProjectCost * 0.18;
  const grandTotal = totalProjectCost + gstValue;

  return {
    baseTotal,
    totalArea,
    totalQty,
    profitPercent,
    profitValue,
    itemsSubtotal,
    installationCost,
    transportCost,
    loadingUnloadingCost,
    beforeDiscount,
    discountPercent,
    discountValue,
    totalProjectCost,
    gstValue,
    grandTotal,
    avgWithoutGst: totalArea > 0 ? totalProjectCost / totalArea : 0,
    avgWithGst: totalArea > 0 ? grandTotal / totalArea : 0,
  };
}

function prepareQuotationPdfData(quotation) {
  const items = Array.isArray(quotation?.items)
    ? quotation.items.map(normalizeItem)
    : [];

  const customerDetails = {
    name: safeString(quotation?.customerDetails?.name),
    email: safeString(quotation?.customerDetails?.email),
    phone: safeString(quotation?.customerDetails?.phone),
    address: safeString(quotation?.customerDetails?.address),
    city: safeString(quotation?.customerDetails?.city),
    state: safeString(quotation?.customerDetails?.state),
    pincode: safeString(quotation?.customerDetails?.pincode),
  };

  const totalArea = items.reduce((sum, item) => sum + item.area * Math.max(1, item.quantity || 1), 0);

  const quotationDetails = {
    id: safeString(
      quotation?.quotationDetails?.id || quotation?.generatedId || quotation?._id
    ),
    date: safeString(quotation?.quotationDetails?.date || quotation?.createdAt),
    displayDate: formatDate(
      quotation?.quotationDetails?.date || quotation?.createdAt
    ),
    opportunity: safeString(quotation?.quotationDetails?.opportunity),
    terms: safeString(quotation?.quotationDetails?.terms),
    notes: safeString(quotation?.quotationDetails?.notes),
  };

  const globalConfig = {
    logo: normalizeImage(quotation?.globalConfig?.logo),
    terms: safeString(quotation?.globalConfig?.terms),
    prerequisites: safeString(quotation?.globalConfig?.prerequisites),
    additionalCosts: {
      installation: toNumber(quotation?.globalConfig?.additionalCosts?.installation),
      transport: toNumber(quotation?.globalConfig?.additionalCosts?.transport),
      loadingUnloading: toNumber(
        quotation?.globalConfig?.additionalCosts?.loadingUnloading
      ),
      discountPercent: toNumber(
        quotation?.globalConfig?.additionalCosts?.discountPercent
      ),
      showInstallation: booleanOr(
        quotation?.globalConfig?.additionalCosts?.showInstallation
      ),
      showTransport: booleanOr(
        quotation?.globalConfig?.additionalCosts?.showTransport
      ),
      showLoadingUnloading: booleanOr(
        quotation?.globalConfig?.additionalCosts?.showLoadingUnloading
      ),
      showDiscount: booleanOr(
        quotation?.globalConfig?.additionalCosts?.showDiscount
      ),
    },
  };

  const profitPercentage = toNumber(quotation?.breakdown?.profitPercentage);
  let totals = computeTotals(items, globalConfig.additionalCosts, profitPercentage);
  const profitAdjustedItems = items.map((item) =>
    addProfitToItemValues(item, profitPercentage)
  );
  const displayedItemsSubtotal = profitAdjustedItems.reduce(
    (sum, item) => sum + toNumber(item.amount),
    0
  );

  if (displayedItemsSubtotal !== totals.itemsSubtotal) {
    const beforeDiscount =
      displayedItemsSubtotal +
      totals.installationCost +
      totals.transportCost +
      totals.loadingUnloadingCost;
    const discountValue = (beforeDiscount * totals.discountPercent) / 100;
    const totalProjectCost = beforeDiscount - discountValue;
    const gstValue = totalProjectCost * 0.18;
    const grandTotal = totalProjectCost + gstValue;

    totals = {
      ...totals,
      itemsSubtotal: displayedItemsSubtotal,
      beforeDiscount,
      discountValue,
      totalProjectCost,
      gstValue,
      grandTotal,
      avgWithoutGst: totals.totalArea > 0 ? totalProjectCost / totals.totalArea : 0,
      avgWithGst: totals.totalArea > 0 ? grandTotal / totals.totalArea : 0,
    };
  }

  return {
    generatedId: safeString(quotation?.generatedId),
    createdAt: quotation?.createdAt,
    customerDetails,
    quotationDetails,
    globalConfig,
    items: profitAdjustedItems,
    totalArea,
    breakdown: {
      totalAmount:
        toNumber(quotation?.breakdown?.totalAmount) > 0
          ? toNumber(quotation?.breakdown?.totalAmount)
          : totals.grandTotal,
      profitPercentage,
    },
    totals,
  };
}

function getCompanyAddressBlock(data) {
  const parts = [
    data.name,
    data.address,
    data.city,
    data.state,
    data.pincode,
  ].filter(Boolean);

  return parts.join(", ");
}

function renderCoverPage(data, user) {
  const companyName = escapeHtml(user.name || "Your Company");
  const customerName = escapeHtml(data.customerDetails.name || "Customer");
  const companyAddress = escapeHtml(getCompanyAddressBlock(user));
  const email = escapeHtml(user.email || "");
  const phone = escapeHtml(user.phone || "");
  const quoteNo = escapeHtml(
    data.generatedId || data.quotationDetails.id || "Quotation"
  );
  const quoteDate = escapeHtml(data.quotationDetails.displayDate || "-");

  const logoHtml = data.globalConfig.logo
    ? `<img src="${data.globalConfig.logo}" alt="Logo" class="logo" />`
    : `<div class="logo-fallback">${companyName}</div>`;

  return `
    <section class="page cover-page">
      <div class="cover-top">
        <div>${logoHtml}</div>
        <div class="company-block">
          <div class="company-name">${companyName}</div>
          ${companyAddress ? `<div>${companyAddress}</div>` : ""}
          ${phone ? `<div>Contact No. : ${phone}</div>` : ""}
          ${email ? `<div>Email : ${email}</div>` : ""}
        </div>
      </div>

      <div class="separator"></div>

      <div class="quote-strip">
        Quote No. : ${quoteNo}
        <span class="sep">/</span>
        Project : ${escapeHtml(data.quotationDetails.opportunity || "Enquiry")}
        <span class="sep">/</span>
        Date : ${quoteDate}
      </div>

      <div class="cover-body">

        <div class="letter">
          <p>Dear ${customerName},</p>

          <p>
            We are delighted that you are considering our range of Windows and Doors for your premises.
          </p>

          <p>
            It has gained rapid acceptance across all cities of India for the overwhelming advantages of better protection
            from noise, heat, rain, dust and pollution.
          </p>

          <p>
            In drawing this proposal, it has been our endeavor to suggest designs which would enhance your comfort and
            aesthetics from inside and improve the facade of the building.
          </p>

          <p>
            It has a well-established service network to deliver seamless service at your doorstep. Our offer comprises
            of the following in enclosure for your kind perusal:
          </p>

          <ol>
            <li>Window design, specification and value</li>
            <li>Terms and Conditions</li>
          </ol>

          <p>We now look forward to be of service to you.</p>

          <div class="signoff">
            <div>For ${companyName},</div>
            <div class="auth-gap"></div>
            <div>Authorized Signatory</div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderMainItemCard(item) {
  const imageHtml = item.refImage
    ? `<img src="${item.refImage}" alt="${escapeHtml(item.refCode)}" />`
    : `<div class="image-placeholder">No Image</div>`;

  return `
    <div class="item-card">
      <table class="meta-table">
        <tr>
          <td class="label">Ref-Code</td>
          <td>${escapeHtml(item.refCode)}</td>
          <td class="label">Size</td>
          <td>W = ${item.width || "-"} mm; H = ${item.height || "-"} mm</td>
          <td class="label">Color</td>
          <td>${escapeHtml(item.colorFinish)}</td>
        </tr>
        <tr>
          <td class="label">Product</td>
          <td>${escapeHtml(item.systemType)}</td>
          <td class="label">Handle</td>
          <td>${escapeHtml(formatHandle(item.handleType, item.handleColor))}</td>
          <td class="label">Description</td>
          <td>${escapeHtml(item.description)}</td>
        </tr>
        <tr>
          <td class="label">Location</td>
          <td>${escapeHtml(item.location)}</td>
          <td class="label">Glass</td>
          <td>${escapeHtml(item.glassSpec)}</td>
          <td class="label">Mesh</td>
          <td>${escapeHtml(formatMesh(item.meshPresent, item.meshType))}</td>
        </tr>
      </table>

      <div class="item-body">
        <div class="item-image-col">
          ${imageHtml}
        </div>

        <div class="item-values-col">
          <div class="section-title">Computed Values</div>
          <table class="values-table">
            <tr>
              <td>Series</td>
              <td>${escapeHtml(item.series)}</td>
              <td></td>
            </tr>
            <tr>
              <td>Area</td>
              <td>${item.area.toFixed(2)}</td>
              <td>Sq.ft</td>
            </tr>
            <tr>
              <td>Rate per Sq.ft</td>
              <td>${formatCurrency(item.rate)}</td>
              <td>INR</td>
            </tr>
            <tr>
              <td>Quantity</td>
              <td>${item.quantity}</td>
              <td>pcs</td>
            </tr>
            <tr>
              <td>Amount</td>
              <td>${formatCurrency(item.amount)}</td>
              <td>INR</td>
            </tr>
            <tr>
              <td>Remarks</td>
              <td colspan="2">${escapeHtml(item.remarks)}</td>
            </tr>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderSubItemsTable(subItems) {
  if (!subItems?.length) return "";

  return `
    <div class="subitems-block">
      <div class="section-title">Combination Breakdown</div>
      <table class="subitems-table">
        <thead>
          <tr>
            <th>Ref</th>
            <th>Image</th>
            <th>Product</th>
            <th>Series</th>
            <th>W</th>
            <th>H</th>
            <th>Area</th>
            <th>Color</th>
            <th>Location</th>
            <th>Description</th>
            <th>Glass</th>
            <th>Handle</th>
            <th>Mesh</th>
            <th>Rate</th>
            <th>Qty</th>
            <th>Amount</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          ${subItems
      .map((sub) => {
        const img = sub.refImage
          ? `<img src="${sub.refImage}" alt="${escapeHtml(sub.refCode)}" class="sub-thumb" />`
          : "-";

        return `
                <tr>
                  <td>${escapeHtml(sub.refCode)}</td>
                  <td>${img}</td>
                  <td>${escapeHtml(sub.systemType)}</td>
                  <td>${escapeHtml(sub.series)}</td>
                  <td>${sub.width || "-"}</td>
                  <td>${sub.height || "-"}</td>
                  <td>${sub.area.toFixed(2)}</td>
                  <td>${escapeHtml(sub.colorFinish)}</td>
                  <td>${escapeHtml(sub.location)}</td>
                  <td>${escapeHtml(sub.description)}</td>
                  <td>${escapeHtml(sub.glassSpec)}</td>
                  <td>${escapeHtml(formatHandle(sub.handleType, sub.handleColor))}</td>
                  <td>${escapeHtml(formatMesh(sub.meshPresent, sub.meshType))}</td>
                  <td>${formatCurrency(sub.rate)}</td>
                  <td>${sub.quantity}</td>
                  <td>${formatCurrency(sub.amount)}</td>
                  <td>${escapeHtml(sub.remarks)}</td>
                </tr>
              `;
      })
      .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderItemPage(data, item) {
  return `
    <section class="page">
      <div class="page-header">
        <div class="page-brand">
          ${data.globalConfig.logo
      ? `<img src="${data.globalConfig.logo}" class="header-logo" alt="Logo" />`
      : `<div class="header-company">${escapeHtml(
        data.customerDetails.name || "Customer"
      )}</div>`
    }
        </div>

        <div class="page-meta">
          <div><strong>Quote No:</strong> ${escapeHtml(
      data.generatedId || data.quotationDetails.id || "-"
    )}</div>
          <div><strong>Project:</strong> ${escapeHtml(
      data.quotationDetails.opportunity || "Enquiry"
    )}</div>
          <div><strong>Date:</strong> ${escapeHtml(
      data.quotationDetails.displayDate || "-"
    )}</div>
        </div>
      </div>

      <div class="separator"></div>

      <h2 class="page-title">Window Design, Specification and Value</h2>
      <div class="customer-line">Customer: ${escapeHtml(
      data.customerDetails.name || "-"
    )}</div>
      <div class="page-note">
        Below is the proposed specification and commercial value for the selected windows and doors.
      </div>

      ${renderMainItemCard(item)}
      ${item.isCombination ? renderSubItemsTable(item.subItems) : ""}
    </section>
  `;
}

function renderSummaryPage(data) {
  const additionalCosts = data.globalConfig.additionalCosts || {};

  const installationRow = additionalCosts.showInstallation
    ? `
        <tr>
          <td>Installation</td>
          <td>${formatCurrency(data.totals.installationCost)} INR</td>
        </tr>
      `
    : "";
  const transportRow = additionalCosts.showTransport
    ? `
        <tr>
          <td>Transport</td>
          <td>${formatCurrency(data.totals.transportCost)} INR</td>
        </tr>
      `
    : "";
  const loadingUnloadingRow = additionalCosts.showLoadingUnloading
    ? `
        <tr>
          <td>Loading / Unloading</td>
          <td>${formatCurrency(data.totals.loadingUnloadingCost)} INR</td>
        </tr>
      `
    : "";
  const discountRow = toNumber(data.totals.discountValue) > 0
    ? `
        <tr>
          <td>Discount (${formatCurrency(data.totals.discountPercent)}%)</td>
          <td>- ${formatCurrency(data.totals.discountValue)} INR</td>
        </tr>
      `
    : "";

  return `
    <section class="page">
      <div class="page-header">
        <div class="page-brand">
          ${data.globalConfig.logo
      ? `<img src="${data.globalConfig.logo}" class="header-logo" alt="Logo" />`
      : `<div class="header-company">${escapeHtml(
        data.customerDetails.name || "Customer"
      )}</div>`
    }
        </div>

        <div class="page-meta">
          <div><strong>Quote No:</strong> ${escapeHtml(
      data.quotationDetails.id || data.generatedId || "-"
    )}</div>
          <div><strong>Project:</strong> ${escapeHtml(
      data.quotationDetails.opportunity || "Enquiry"
    )}</div>
          <div><strong>Date:</strong> ${escapeHtml(
      data.quotationDetails.displayDate || "-"
    )}</div>
        </div>
      </div>

      <div class="separator"></div>

      <h2 class="page-title">Quotation Summary</h2>

      <table class="summary-table">
        <tr>
          <td>Quantity</td>
          <td>${data.totals.totalQty}</td>
        </tr>
        <tr>
          <td>Total Area</td>
          <td>${data.totals.totalArea.toFixed(2)} Sq.ft</td>
        </tr>
        ${installationRow}
        ${transportRow}
        ${loadingUnloadingRow}
        <tr>
          <td>Items Subtotal</td>
          <td>${formatCurrency(data.totals.itemsSubtotal)} INR</td>
        </tr>
        ${discountRow}
        <tr>
          <td>Total Project Cost</td>
          <td>${formatCurrency(data.totals.totalProjectCost)} INR</td>
        </tr>
        <tr>
          <td>GST 18%</td>
          <td>${formatCurrency(data.totals.gstValue)} INR</td>
        </tr>
        <tr class="grand-total">
          <td>Grand Total</td>
          <td>${formatCurrency(data.totals.grandTotal)} INR</td>
        </tr>
        <tr>
          <td>Avg. Price Per Sq. Ft. Without GST</td>
          <td>${formatCurrency(data.totals.avgWithoutGst)} INR</td>
        </tr>
        <tr>
          <td>Avg. Price Per Sq. Ft. With GST</td>
          <td>${formatCurrency(data.totals.avgWithGst)} INR</td>
        </tr>
      </table>

      ${data.quotationDetails.notes
      ? `
          <div class="text-block">
            <div class="section-title">Notes</div>
            <div class="rich-text">${nl2br(data.quotationDetails.notes)}</div>
          </div>
        `
      : ""
    }

      <div class="final-sign">
        <div>For ${escapeHtml(data.customerDetails.name || "Customer")}</div>
        <div class="auth-gap"></div>
        <div>Authorized Signatory</div>
      </div>
    </section>
  `;
}

function renderTermsPage(data) {
  const terms = data.quotationDetails.terms || data.globalConfig.terms || "";
  const prerequisites = data.globalConfig.prerequisites || "";

  if (!prerequisites && !terms) return "";

  return `
    <section class="page">
      <div class="page-header">
        <div class="page-brand">
          ${data.globalConfig.logo
      ? `<img src="${data.globalConfig.logo}" class="header-logo" alt="Logo" />`
      : `<div class="header-company">${escapeHtml(
        data.customerDetails.name || "Customer"
      )}</div>`
    }
        </div>

        <div class="page-meta">
          <div><strong>Quote No:</strong> ${escapeHtml(
      data.quotationDetails.id || data.generatedId || "-"
    )}</div>
          <div><strong>Project:</strong> ${escapeHtml(
      data.quotationDetails.opportunity || "Enquiry"
    )}</div>
          <div><strong>Date:</strong> ${escapeHtml(
      data.quotationDetails.displayDate || "-"
    )}</div>
        </div>
      </div>

      <div class="separator"></div>

      <h2 class="page-title">Prerequisites & Terms</h2>

      ${prerequisites
      ? `
          <div class="text-block">
            <div class="section-title">Prerequisites</div>
            <div class="rich-text">${nl2br(prerequisites)}</div>
          </div>
        `
      : ""
    }

      ${terms
      ? `
          <div class="text-block">
            <div class="section-title">Terms & Conditions</div>
            <div class="rich-text">${nl2br(terms)}</div>
          </div>
        `
      : ""
    }
    </section>
  `;
}

function buildPdfHtml(data, user) {
  const pages = [
    renderCoverPage(data, user),
    ...data.items.map((item) => renderItemPage(data, item)),
    renderSummaryPage(data),
    renderTermsPage(data),
  ].join("");

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>Quotation PDF</title>
        <style>
          @page {
            size: A4;
            margin: 12mm;
          }

          * {
            box-sizing: border-box;
          }

          html, body {
            margin: 0;
            padding: 0;
            font-family: Arial, Helvetica, sans-serif;
            color: #1e1e1e;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          body {
            font-size: 11px;
            background: #fff;
          }

          .page {
            page-break-after: always;
          }

          .page:last-child {
            page-break-after: auto;
          }

          .cover-page {
            min-height: 270mm;
          }

          .cover-top,
          .page-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 16px;
          }

          .logo,
          .header-logo {
            max-width: 180px;
            max-height: 70px;
            object-fit: contain;
          }

          .logo-fallback,
          .header-company,
          .company-name {
            font-size: 20px;
            font-weight: 700;
          }

          .company-block,
          .page-meta {
            text-align: right;
            line-height: 1.5;
            font-size: 12px;
            max-width: 320px;
          }

          .separator {
            border-top: 2px solid #aa9f89;
            margin: 14px 0 18px;
          }

          .quote-strip {
            text-align: right;
            font-size: 14px;
            margin-bottom: 42px;
          }

          .quote-strip .sep {
            margin: 0 8px;
          }

          .cover-body {
            margin-top: 40px;
          }

          .to-block {
            font-size: 16px;
            font-weight: 700;
            margin-bottom: 48px;
          }

          .recipient {
            margin-top: 8px;
            font-size: 18px;
          }

          .letter {
            font-size: 15px;
            line-height: 1.7;
          }

          .letter p {
            margin: 0 0 20px;
          }

          .letter ol {
            margin: 0 0 20px 28px;
          }

          .letter li {
            margin-bottom: 8px;
          }

          .signoff,
          .final-sign {
            margin-top: 48px;
            font-size: 15px;
          }

          .auth-gap {
            height: 56px;
          }

          .page-title {
            margin: 0 0 8px;
            font-size: 28px;
            line-height: 1.2;
          }

          .customer-line,
          .page-note {
            font-size: 13px;
            margin-bottom: 10px;
          }

          .item-card {
            border: 1px solid #a7a7a7;
            border-radius: 10px;
            overflow: hidden;
            margin-top: 14px;
          }

          .meta-table,
          .values-table,
          .subitems-table,
          .summary-table {
            width: 100%;
            border-collapse: collapse;
          }

          .meta-table td,
          .values-table td,
          .subitems-table th,
          .subitems-table td,
          .summary-table td {
            border: 1px solid #d3d3d3;
            padding: 8px 10px;
            vertical-align: top;
          }

          .meta-table .label {
            font-weight: 700;
            background: #f4f4f4;
            width: 12%;
            white-space: nowrap;
          }

          .item-body {
            display: grid;
            grid-template-columns: 1fr 1fr;
            align-items: stretch;
          }

          .item-image-col {
            min-height: 280px;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 18px;
            border-right: 1px solid #d3d3d3;
          }

          .item-image-col img {
            max-width: 100%;
            max-height: 240px;
            object-fit: contain;
          }

          .image-placeholder {
            color: #7a7a7a;
            font-size: 14px;
          }

          .item-values-col {
            padding: 0;
          }

          .section-title {
            font-size: 16px;
            font-weight: 700;
            padding: 12px 14px;
            background: #f4f4f4;
            border-bottom: 1px solid #d3d3d3;
          }

          .values-table td:first-child {
            width: 38%;
            font-weight: 700;
            background: #fafafa;
          }

          .subitems-block {
            margin-top: 18px;
            page-break-inside: auto;
          }

          .subitems-table {
            table-layout: auto;
            font-size: 8.5px;
            width: 100%;
          }

          .subitems-table th,
          .subitems-table td {
            padding: 4px 3px;
            word-wrap: break-word;
            overflow-wrap: break-word;
          }

          .subitems-table th:nth-child(5),
          .subitems-table th:nth-child(6),
          .subitems-table th:nth-child(15) {
            width: 3%;
          }
          .subitems-table th:nth-child(7),
          .subitems-table th:nth-child(14) {
            width: 5%;
          }

          .subitems-table thead {
            display: table-header-group;
          }

          .subitems-table th {
            background: #f4f4f4;
            font-weight: 700;
          }

          .subitems-table tr {
            page-break-inside: avoid;
          }

          .sub-thumb {
            max-width: 42px;
            max-height: 42px;
            object-fit: contain;
          }

          .summary-table {
            margin-top: 18px;
            font-size: 14px;
          }

          .summary-table td:first-child {
            font-weight: 700;
            width: 65%;
            background: #fafafa;
          }

          .grand-total td {
            font-size: 16px;
            font-weight: 700;
            background: #ececec;
          }

          .text-block {
            margin-top: 22px;
            border: 1px solid #d3d3d3;
            border-radius: 10px;
            overflow: hidden;
          }

          .rich-text {
            padding: 14px;
            font-size: 13px;
            line-height: 1.7;
          }

          @media print {
            .page {
              page-break-after: always;
            }

            .page:last-child {
              page-break-after: auto;
            }
          }
        </style>
      </head>
      <body>
        ${pages}
      </body>
    </html>
  `;
}

const generateQuotationPdfController = async (req, res) => {
  let browserHandle;
  let page;

  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Quotation id is required.",
      });
    }

    console.log(req.user, "User>>>>>>");

    const user = await User.findById(req.user.userId);

    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { generatedId: id }] }
      : { generatedId: id };

    const quotation = await Quotation.findOne(query).lean();

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found.",
      });
    }

    const preparedData = prepareQuotationPdfData(quotation);
    const html = buildPdfHtml(preparedData, user);

    browserHandle = await launchPdfBrowser();
    const { browser } = browserHandle;

    page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: ["domcontentloaded", "networkidle2"],
      timeout: 60000,
    });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "12mm",
        right: "12mm",
        bottom: "12mm",
        left: "12mm",
      },
      preferCSSPageSize: true,
    });

    const fileName = `${safeString(preparedData.quotationDetails.id) ||
      safeString(preparedData.generatedId) ||
      "quotation"
      }.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
  } catch (error) {
    console.error("generateQuotationPdfController error:", error);

    if (error.code === "ENOSPC") {
      return res.status(507).json({
        success: false,
        message: "Server does not have enough free disk space to generate quotation PDF.",
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to generate quotation PDF.",
      error: error.message,
    });
  } finally {
    try {
      if (page && !page.isClosed()) {
        await page.close();
      }
    } finally {
      await closePdfBrowser(browserHandle);
    }
  }
};


module.exports = {
  getSystems,
  getSeries,
  getDescriptions,
  getOptionLists,
  previewRate,
  createQuotation,
  listQuotations,
  getQuotationById,
  updateQuotationById,
  deleteQuotationById,
  generateQuotationPdfController
};
