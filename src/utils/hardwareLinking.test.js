const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateShutterGlassWeight, matchesWeightCondition, resolveLinkedHardware } = require("./hardwareLinking");

test("calculates individual shutter glass weight from metric dimensions", () => {
  assert.equal(calculateShutterGlassWeight({ widthMm: 2000, heightMm: 1000, shutterCount: 2, glassThicknessMm: 6 }), 19.2);
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
      conditions: [{ operator: "<=", weightKg: 20, hardware: [
        { sapCode: "COMMON", quantity: 1, applicability: "always" },
        { sapCode: "HINGE", quantity: 2, applicability: "hinges" },
        { sapCode: "STAY", quantity: 3, applicability: "frictionStay" },
      ] }],
    }],
  };
  const result = resolveLinkedHardware({ glassThicknesses: { "6mm Clear": 6 }, config, glassSpec: "6mm Clear", widthMm: 2000, heightMm: 1000, hardwareOpeningType: "hinges" });
  assert.deepEqual(result.lines.map((line) => [line.sapCode, line.quantity]), [["COMMON", 2], ["HINGE", 4]]);
});
test('thickness changes hardware weight band and supports decimal millimetres', () => {
  const config={shutterCount:1,glassRules:[{glassSpec:'Clear',conditions:[
    {operator:'<',weightKg:20,hardware:[{sapCode:'LIGHT',quantity:1}]},
    {operator:'>=',weightKg:20,hardware:[{sapCode:'HEAVY',quantity:1}]}
  ]}]};
  const resolve = thickness => resolveLinkedHardware({config,glassSpec:'Clear',widthMm:1000,heightMm:1000,glassThicknesses:{Clear:thickness}});
  assert.equal(resolve(6).shutterWeightKg,19.2);
  assert.equal(resolve(6).lines[0].sapCode,'LIGHT');
  assert.equal(resolve(6.5).shutterWeightKg,20.8);
  assert.equal(resolve(6.5).lines[0].sapCode,'HEAVY');
  assert.throws(()=>resolve(undefined),/Set glass thickness/);
  assert.throws(()=>resolve(0),/Set glass thickness/);
});
test('loads saved thickness with escaped glass names and matches case-insensitively', async t => {
  const OptionSet=require('../models/Quotation/OptionSet');
  const {loadGlassThicknesses}=require('./hardwareLinking');
  t.mock.method(OptionSet,'findOne',filter=>{
    assert.deepEqual(filter,{type:'glassSpec',system:{$exists:false}});
    return {select:()=>({lean:async()=>({glassThicknessMm:new Map([['6[dot]5 Clear',6.5]])})})};
  });
  const glassThicknesses=await loadGlassThicknesses();
  const result=resolveLinkedHardware({glassThicknesses,glassSpec:'6.5 clear',widthMm:1000,heightMm:1000,config:{glassRules:[{glassSpec:'6.5 Clear',conditions:[]}]}});
  assert.equal(result.shutterWeightKg,20.8);
});
