const OptionSet = require("../models/Quotation/OptionSet");
const { restoreRateMap } = require("./rateMapUtils");

const loadGlassThicknesses = async () => {
  const options = await OptionSet.findOne({ type: "glassSpec", system: { $exists: false } }).select("glassThicknessMm").lean();
  return restoreRateMap(options?.glassThicknessMm);
};

const { toNumber } = require("./cuttingSchedule");

const matchesWeightCondition = (weight, operator, threshold) => {
  const left = toNumber(weight);
  const right = toNumber(threshold);
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  if (operator === ">") return left > right;
  if (operator === ">=") return left >= right;
  return Math.abs(left - right) < 0.000001;
};

const calculateShutterGlassWeight = ({ widthMm, heightMm, shutterCount = 1, glassThicknessMm }) => {
  const thickness = Number(glassThicknessMm);
  if (!Number.isFinite(thickness) || thickness <= 0) throw new Error("A positive glass thickness in mm is required to calculate shutter weight");
  const count = Math.max(1, Math.round(toNumber(shutterCount, 1)));
  const widthMetres = toNumber(widthMm) / 1000 / count;
  const heightMetres = toNumber(heightMm) / 1000;
  return Math.round(heightMetres * widthMetres * 2.56 * 1.25 * thickness * 1000) / 1000;
};

const resolveLinkedHardware = ({ config, glassSpec, widthMm, heightMm, hardwareOpeningType, glassThicknesses = {} }) => {
  if (!config) return { shutterCount: 0, shutterWeightKg: 0, lines: [] };
  const shutterCount = Math.max(1, Math.round(toNumber(config.shutterCount, 1)));
  const rule = (config.glassRules || []).find(
    (entry) => String(entry.glassSpec || "").trim().toLowerCase() === String(glassSpec || "").trim().toLowerCase()
  );
  if (!rule) return { shutterCount, shutterWeightKg: 0, lines: [] };
  const selectedGlass = String(glassSpec || "").trim().toLowerCase();
  const glassThicknessMm = Object.entries(glassThicknesses).find(([name]) => name.trim().toLowerCase() === selectedGlass)?.[1];
  if (!(Number(glassThicknessMm) > 0) || !Number.isFinite(Number(glassThicknessMm))) {
    throw new Error(`Set glass thickness for "${glassSpec}" in Admin → Quotation Options before calculating shutter hardware`);
  }
  const shutterWeightKg = calculateShutterGlassWeight({ widthMm, heightMm, shutterCount, glassThicknessMm });

  const lines = [];
  (rule.conditions || []).forEach((condition) => {
    if (!matchesWeightCondition(shutterWeightKg, condition.operator, condition.weightKg)) return;
    (condition.hardware || []).forEach((line) => {
      const applicability = line.applicability || "always";
      if (applicability !== "always" && applicability !== hardwareOpeningType) return;
      lines.push({
        sapCode: String(line.sapCode || "").trim(),
        description: String(line.description || "").trim(),
        quantity: toNumber(line.quantity, 1) * shutterCount,
        applicability,
      });
    });
  });
  return { shutterCount, shutterWeightKg, lines };
};

module.exports = { loadGlassThicknesses, calculateShutterGlassWeight, matchesWeightCondition, resolveLinkedHardware };
