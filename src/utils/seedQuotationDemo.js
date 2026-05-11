/* Seed dummy data for quotation config to make endpoints testable */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../db");
const System = require("../models/Quotation/System");
const Series = require("../models/Quotation/Series");
const OptionSet = require("../models/Quotation/OptionSet");
const AreaSlab = require("../models/Quotation/AreaSlab");
const BaseRate = require("../models/Quotation/BaseRate");
const HandleRule = require("../models/Quotation/HandleRule");
const HandleOption = require("../models/Quotation/HandleOption");

const upsert = (Model, filter, payload) =>
  Model.updateOne(filter, { $set: payload }, { upsert: true });

const run = async () => {
  try {
    await connectDB();
    console.log("🔗 Connected");

    // Clear all quotation-related collections
    await Promise.all([
      System.deleteMany({}),
      Series.deleteMany({}),
      OptionSet.deleteMany({}),
      AreaSlab.deleteMany({}),
      BaseRate.deleteMany({}),
      HandleRule.deleteMany({}),
      HandleOption.deleteMany({}),
    ]);
    console.log("🧹 Cleared old quotation data");

    // Area slabs
    const slabs = [
      { label: "0-20", max: 20, order: 0 },
      { label: "20-40", max: 40, order: 1 },
      { label: "40+", max: Infinity, order: 2 },
    ];
    await AreaSlab.insertMany(
      slabs.map((s) => ({ ...s, max: Number.isFinite(s.max) ? s.max : 10_000_000 }))
    );
    console.log("✅ Area slabs seeded");

    // Systems
    const systems = [
      {
        name: "Casement",
        colorFinishes: ["Premium White", "Jet Black", "Anodized Silver"],
        meshTypes: ["None", "SS 304"],
        glassSpecs: ["5mm Clear Toughened", "12mm DGU"],
        handleColors: ["Black", "Chrome"],
      },
      {
        name: "Sliding",
        colorFinishes: ["Jet Black", "Woodgrain Teak"],
        meshTypes: ["None", "Fiberglass"],
        glassSpecs: ["6mm Clear Toughened", "Low-E DGU"],
        handleColors: ["Black", "SS Finish"],
      },
    ];
    const systemDocs = await System.insertMany(systems);
    console.log("✅ Systems seeded");

    // Option sets (global fallbacks)
    const optionSets = [
      { type: "colorFinish", values: { "Premium White": 0, "Jet Black": 0, "Anodized Silver": 0 } },
      { type: "glassSpec", values: { "5mm Clear Toughened": 0, "6mm Clear Toughened": 0, "12mm DGU": 0 } },
      { type: "meshType", values: { None: 0, "SS 304": 0, Fiberglass: 0 } },
    ];
    await OptionSet.insertMany(optionSets);
    console.log("✅ Option sets seeded");

    // Series + description metadata
    const casement40Descriptions = [
      { name: "Fix", handleTypes: ["None"], handleCount: 0 },
      { name: "Left Openable Window", handleTypes: ["Crescent"], handleCount: 1 },
      { name: "Right Openable Window", handleTypes: ["Crescent"], handleCount: 1 },
      { name: "French Window", handleTypes: ["Two Point"], handleCount: 2 },
    ];
    const sliding29Descriptions = [
      { name: "2 Track 2 Glass Panel", handleTypes: ["Sliding"], handleCount: 2 },
      { name: "2 Track 3 Glass Panel", handleTypes: ["Sliding"], handleCount: 3 },
      { name: "3 Track 2 Glass 1 Mesh Panel", handleTypes: ["Sliding"], handleCount: 3 },
    ];

    const casementSystem = systemDocs.find((s) => s.name === "Casement");
    const slidingSystem = systemDocs.find((s) => s.name === "Sliding");

    await Series.insertMany([
      { name: "40mm", system: casementSystem._id, descriptions: casement40Descriptions },
      { name: "29mm", system: slidingSystem._id, descriptions: sliding29Descriptions },
    ]);
    console.log("✅ Series seeded");

    // Base rates (3 slabs -> 3 numbers)
    const baseRates = [
      {
        systemType: "Casement",
        series: "40mm",
        description: "Fix",
        rates: [200, 170, 145],
      },
      {
        systemType: "Casement",
        series: "40mm",
        description: "French Window",
        rates: [330, 281, 238],
      },
      {
        systemType: "Sliding",
        series: "29mm",
        description: "2 Track 2 Glass Panel",
        rates: [500, 425, 361],
      },
      {
        systemType: "Sliding",
        series: "29mm",
        description: "3 Track 2 Glass 1 Mesh Panel",
        rates: [600, 510, 434],
      },
    ];
    await BaseRate.insertMany(baseRates);
    console.log("✅ Base rates seeded");

    // Handle rules (defaults; series metadata already has counts but these are examples)
    const handleRules = [
      {
        description: "French Window",
        systemType: "Casement",
        series: "40mm",
        handleTypes: ["Two Point", "D Handle"],
        handleCount: 2,
      },
      {
        description: "2 Track 2 Glass Panel",
        systemType: "Sliding",
        handleTypes: ["Sliding"],
        handleCount: 2,
      },
    ];
    await HandleRule.insertMany(handleRules);
    console.log("✅ Handle rules seeded");

    // Handle options with rates per color
    const handleOptions = [
      {
        systemType: "Sliding",
        name: "Metro Handle",
        colors: { Black: 650, Silver: 650 },
      },
      {
        systemType: "Sliding",
        name: "Touch Lock",
        colors: { Black: 250, Silver: 250 },
      },
      {
        systemType: "Sliding",
        name: "D handle",
        colors: { Black: 600, Silver: 600 },
      },
      {
        systemType: "Sliding",
        name: "Pop-up handle",
        colors: { Black: 350, Silver: 350 },
      },
      {
        systemType: "Casement",
        name: "Mortise Handle with lock",
        colors: { Black: 1500, Silver: 1500 },
      },
      {
        systemType: "Casement",
        name: "L handle",
        colors: { Black: 350, Silver: 350 },
      },
      {
        systemType: "Casement",
        name: "Cremone Handle",
        colors: { Black: 250, Silver: 250 },
      },
      {
        systemType: "Casement",
        name: "Cocksper Handle",
        colors: { Black: 100, Silver: 100 },
      },
    ];

    await HandleOption.insertMany(handleOptions);
    console.log("✅ Handle options seeded");

    console.log("\n🎉 Demo quotation data seeded. You can now hit the quotation endpoints.");
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Seed failed", err);
    process.exit(1);
  }
};

run();
