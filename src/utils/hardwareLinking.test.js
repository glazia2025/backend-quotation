const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateShutterGlassWeight, matchesWeightCondition, resolveLinkedHardware } = require("./hardwareLinking");

test("calculates individual shutter glass weight from metric dimensions", () => {
  assert.equal(calculateShutterGlassWeight({ widthMm: 2000, heightMm: 1000, shutterCount: 2 }), 3.2);
});

test("supports configured comparison operators", () => {
  assert.equal(matchesWeightCondition(400, "<", 500), true);
  assert.equal(matchesWeightCondition(500, ">", 500), false);
  assert.equal(matchesWeightCondition(700, "=", 700), true);
});

test("resolves common and hinges-only hardware per shutter", () => {
  const config = {
    shutterCount: 2,
    glassRules: [{
      glassSpec: "6mm Clear",
      conditions: [{ operator: "<=", weightKg: 4, hardware: [
        { sapCode: "COMMON", quantity: 1, applicability: "always" },
        { sapCode: "HINGE", quantity: 2, applicability: "hinges" },
        { sapCode: "STAY", quantity: 3, applicability: "frictionStay" },
      ] }],
    }],
  };
  const result = resolveLinkedHardware({ config, glassSpec: "6mm Clear", widthMm: 2000, heightMm: 1000, hardwareOpeningType: "hinges" });
  assert.deepEqual(result.lines.map((line) => [line.sapCode, line.quantity]), [["COMMON", 2], ["HINGE", 4]]);
});
