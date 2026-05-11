const mongoose = require("mongoose");

const CuttingScheduleConfig = require("../models/Quotation/CuttingScheduleConfig");
const Quotation = require("../models/Quotation/Quotation");
const Series = require("../models/Quotation/Series");
const { closePdfBrowser, launchPdfBrowser } = require("../utils/pdfBrowser");
const {
  escapeHtml,
  evaluateFormula,
  resolveCatalogProduct,
  round3,
  searchCatalogProducts,
  toNumber,
} = require("../utils/cuttingSchedule");

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
        return {
          systemType,
          series: seriesItem.name,
          description: description.name,
          configId: config?._id,
          lineCount: getConfiguredLineCount(config),
          configured: Boolean(config),
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

const normalizeLine = (line = {}, index = 0) => ({
  itemType: line.itemType === "hardware" ? "hardware" : "profile",
  sapCode: String(line.sapCode || "").trim(),
  description: String(line.description || "").trim(),
  quantityFormula: String(line.quantityFormula || "1").trim(),
  dimensionFormula:
    line.itemType === "hardware" ? "" : String(line.dimensionFormula || "").trim(),
  cutAngle:
    line.itemType === "hardware"
      ? ""
      : String(line.cutAngle || line.cutAngleLeft || line.cutAngleRight || "").trim(),
  position: String(line.position || "").trim(),
  unit: String(line.unit || "Pcs").trim(),
  sortOrder: Number.isFinite(Number(line.sortOrder)) ? Number(line.sortOrder) : index,
});

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

  const horizontalAngle = item?.horizontalCutAngle || item?.cutAngleHorizontal || item?.hCutAngle;
  const verticalAngle = item?.verticalCutAngle || item?.cutAngleVertical || item?.vCutAngle;
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
      defaultScheduleKey: isCuttingScheduleKey(req.body.defaultScheduleKey)
        ? req.body.defaultScheduleKey
        : "90_90",
    };

    if (!payload.systemType || !payload.series || !payload.description) {
      return res.status(400).json({ message: "systemType, series and description are required" });
    }

    if (payload.schedules.some((schedule) => schedule.lines.some((line) => !line.sapCode))) {
      return res.status(400).json({ message: "Every cutting schedule line needs a SAP code" });
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

const buildScheduleData = async (quotation) => {
  const sourceItems = itemRowsForSchedule(quotation);
  const keys = sourceItems.map((item) => ({
    systemType: item.systemType || "",
    series: item.series || "",
    description: item.description || "",
  }));

  const configs = await CuttingScheduleConfig.find({
    $or: keys.length ? keys : [{ systemType: "__none__" }],
  }).lean();

  const configMap = configs.reduce((acc, config) => {
    acc[`${config.systemType}||${config.series}||${config.description}`] = config;
    return acc;
  }, {});

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

    for (const line of schedule?.lines || []) {
      const catalogProduct = await resolveCatalogProduct(line);
      const qty = evaluateFormula(line.quantityFormula || "1", variables);
      const dimension =
        line.itemType === "profile" && line.dimensionFormula
          ? evaluateFormula(line.dimensionFormula, variables)
          : "";

      rows.push({
        itemType: line.itemType,
        description: line.description || catalogProduct?.label || line.sapCode,
        sapCode: line.sapCode,
        dimension,
        cutAngle: line.cutAngle || line.cutAngleLeft || line.cutAngleRight || "",
        quantity: qty,
        unit: line.unit || "Pcs",
        position: line.position || "",
        sortOrder: line.sortOrder || 0,
      });
    }

    const sortedRows = rows.sort((a, b) => a.sortOrder - b.sortOrder);
    if (!sortedRows.length) {
      continue;
    }

    sections.push({
      item,
      configFound: Boolean(config),
      scheduleKey: schedule?.key || "",
      horizontalAngle: schedule?.horizontalAngle || "",
      verticalAngle: schedule?.verticalAngle || "",
      rows: sortedRows,
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
  rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.itemType === "profile" ? "Profile" : "Fabrication Hardware")}</td>
          <td>${escapeHtml(row.description)}</td>
          <td>${escapeHtml(row.sapCode)}</td>
          <td class="num">${row.dimension === "" ? "" : escapeHtml(round3(row.dimension))}</td>
          <td class="num">${escapeHtml(row.cutAngle)}</td>
          <td class="num">${escapeHtml(row.quantity)}</td>
          <td>${escapeHtml(row.unit)}</td>
          <td>${escapeHtml(row.position)}</td>
        </tr>
      `
    )
    .join("");

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
                  <tr><td class="label">Glass</td><td>${escapeHtml(item.glassSpec || "-")}</td></tr>
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
              </div>
            `;
          })
          .join("")
          : '<div class="no-data">No cutting schedule formulas are configured for the selected products and cut angle combinations.</div>'}
      </body>
    </html>
  `;
};

const generateCuttingSchedulePdf = async (req, res) => {
  let browserHandle;
  let page;
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

    const data = await buildScheduleData(quotation);
    const html = buildPdfHtml(data);

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
      margin: { top: "8mm", right: "8mm", bottom: "8mm", left: "8mm" },
      preferCSSPageSize: true,
    });

    const fileName = `${data.projectCode || "quotation"}-cutting-schedule.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
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
  deleteConfig,
  generateCuttingSchedulePdf,
  getConfig,
  getDescriptionCatalog,
  listConfigs,
  searchCatalog,
  upsertConfig,
};
