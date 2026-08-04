const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __test: {
    calculateProfileMaterialBaseRate,
    calculateJoinMaterialRate,
    resolveProfileAdjustment,
    scheduleKeyForItem,
  },
} = require("../services/quotationRateService");

test("profile adjustment follows storefront precedence and default", () => {
  const profile = { categoryName: "Casement", optionName: "Premium" };
  assert.equal(resolveProfileAdjustment({ "Casement - Premium": 135 }, profile), 135);
  assert.equal(resolveProfileAdjustment({ "Casement-Premium": 125 }, profile), 125);
  assert.equal(resolveProfileAdjustment({ Casement: 115 }, profile), 115);
  assert.equal(resolveProfileAdjustment({ Casement: 0 }, profile), 100);
  assert.equal(resolveProfileAdjustment({}, profile), 100);
});

test("schedule key is derived from selected frame and shutter angles", () => {
  assert.equal(scheduleKeyForItem({ frameCutAngle: "45", shutterCutAngle: "90" }), "45_90");
  assert.equal(scheduleKeyForItem({ cuttingScheduleKey: "90_45" }), "90_45");
});

test("cutting schedule profile weight produces a per-square-foot base rate", () => {
  const result = calculateProfileMaterialBaseRate({
    item: { width: 1000, height: 1000, area: 10 },
    schedule: {
      lines: [{
        itemType: "profile",
        sapCode: "P-1",
        description: "Frame",
        quantityFormula: "2",
        dimensionFormula: "W",
      }],
    },
    productsByCode: new Map([["P-1", { sapCode: "P-1", kgm: 2 }]]),
    profileMetadataByCode: new Map([["P-1", {
      sapCode: "P-1",
      kgm: 2,
      categoryName: "Casement",
      optionName: "Premium",
    }]]),
    profilePricing: { "Casement - Premium": 100 },
    nalcoPrice: 250000,
  });

  // 2 pieces × 1.010 m × 2 kg/m = 4.04 kg; ₹350/kg = ₹1,414.
  assert.equal(result.totalWeightKg, 4.04);
  assert.equal(result.materialValue, 1414);
  assert.equal(result.baseRate, 141.4);
});

test("an unconfigured optional mullion or coupler is excluded from the rate", () => {
  const result = calculateJoinMaterialRate({
    item: { joinType: "Coupler", series: "40mm", area: 10 },
    lines: undefined,
    productsByCode: new Map(),
    profileMetadataByCode: new Map(),
    profilePricing: {},
    nalcoPrice: 250000,
  });

  assert.equal(result.materialValue, 0);
  assert.equal(result.baseRate, 0);
  assert.deepEqual(result.profiles, []);
  assert.match(result.warnings[0], /excluded from rate/);
});

test("a missing optional join profile does not prevent configured profiles from pricing", () => {
  const result = calculateJoinMaterialRate({
    item: { joinType: "Coupler", series: "40mm", height: 1000, area: 10 },
    lines: [
      { sapCode: "MISSING", formula: "H" },
      { sapCode: "C-1", formula: "H" },
    ],
    productsByCode: new Map([["C-1", { sapCode: "C-1", kgm: 2 }]]),
    profileMetadataByCode: new Map(),
    profilePricing: {},
    nalcoPrice: 250000,
  });

  assert.equal(result.profiles.length, 1);
  assert.equal(result.materialValue, 707);
  assert.equal(result.baseRate, 70.7);
  assert.match(result.warnings[0], /MISSING.*excluded from rate/);
});
