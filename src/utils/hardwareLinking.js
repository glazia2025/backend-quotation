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

const calculateShutterGlassWeight = ({ widthMm, heightMm, shutterCount = 1 }) => {
  const count = Math.max(1, Math.round(toNumber(shutterCount, 1)));
  const widthMetres = toNumber(widthMm) / 1000 / count;
  const heightMetres = toNumber(heightMm) / 1000;
  return Math.round(heightMetres * widthMetres * 2.56 * 1.25 * 1000) / 1000;
};

const resolveLinkedHardware = ({ config, glassSpec, widthMm, heightMm, hardwareOpeningType }) => {
  if (!config) return { shutterCount: 0, shutterWeightKg: 0, lines: [] };
  const shutterCount = Math.max(1, Math.round(toNumber(config.shutterCount, 1)));
  const shutterWeightKg = calculateShutterGlassWeight({ widthMm, heightMm, shutterCount });
  const rule = (config.glassRules || []).find(
    (entry) => String(entry.glassSpec || "").trim().toLowerCase() === String(glassSpec || "").trim().toLowerCase()
  );
  if (!rule) return { shutterCount, shutterWeightKg, lines: [] };

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

module.exports = { calculateShutterGlassWeight, matchesWeightCondition, resolveLinkedHardware };
