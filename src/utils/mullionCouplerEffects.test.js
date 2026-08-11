const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __test: {
    buildGlassDimensionEffects,
    compileGlassRows,
    consolidateCombinationGlassSections,
    evaluateGlassDimensionFormula,
    getDisplayCutAngles,
    getJoinFormulaVariables,
    getJoinOrientation,
    getJoinLinesForOrientation,
    getScheduledLineQuantity,
    itemRowsForSchedule,
    parseGlassDimensions,
    consumeProfileLength,
  },
} = require("../controllers/cuttingScheduleController");
const {
  __test: {
    collectLayoutNodeIds,
    remapConfiguratorLayout,
    resolveJoinEndpoint,
  },
} = require("./quotationItems");

test("glass report parses evaluated width and height dimensions", () => {
  assert.deepEqual(parseGlassDimensions("1271 x 2687"), { widthMm: 1271, heightMm: 2687 });
  assert.deepEqual(parseGlassDimensions("683 × 2530"), { widthMm: 683, heightMm: 2530 });
  assert.deepEqual(parseGlassDimensions(""), { widthMm: 0, heightMm: 0 });
});

test("cutting schedule multiplies each configured line quantity by item quantity", () => {
  assert.equal(
    getScheduledLineQuantity("2", { W: 1000, H: 1200, AREA: 12 }, 4),
    8
  );
  assert.equal(
    getScheduledLineQuantity("Q * 2", { W: 1000, H: 1200, AREA: 12 }, 4),
    8
  );
});

test("profile stock consumption retains leftovers across individual items", () => {
  const leftovers = {};
  const firstItem = consumeProfileLength("P-1", 3010, 1, 6500, leftovers);
  const secondItem = consumeProfileLength("P-1", 3010, 1, 6500, leftovers);

  assert.equal(firstItem.profilesUsed, 1);
  assert.equal(secondItem.profilesUsed, 0);
  assert.deepEqual(leftovers["P-1"], [480]);
});

const makeEntry = (split) => {
  const vertical = split === "vertical";
  const first = { id: "first", width: vertical ? 500 : 1000, height: vertical ? 1000 : 500 };
  const second = { id: "second", width: vertical ? 500 : 1000, height: vertical ? 1000 : 500 };
  return {
    parent: {
      width: 1000,
      height: 1000,
      subItems: [first, second],
      configuratorLayout: {
        children: vertical
          ? [
              { id: "old-first", x: 0, y: 0, w: 0.5, h: 1 },
              { id: "old-second", x: 0.5, y: 0, w: 0.5, h: 1 },
            ]
          : [
              { id: "old-first", x: 0, y: 0, w: 1, h: 0.5 },
              { id: "old-second", x: 0, y: 0.5, w: 1, h: 0.5 },
            ],
      },
    },
    join: { p1: "first", p2: "second", type: "Mullion" },
    first,
    second,
    source: first,
    systemType: "Casement",
    series: "CS-1",
  };
};

test("vertical divider reduces glass width on both adjoining sections", () => {
  const entry = makeEntry("vertical");
  assert.equal(getJoinOrientation(entry), "vertical");

  const effects = buildGlassDimensionEffects([entry], {
    "Casement||CS-1": {
      mullions: [
        { glassDimensionEffect: 12.5 },
        { glassDimensionEffect: 2.5 },
      ],
    },
  });

  assert.deepEqual(effects.get("first"), { width: 15, height: 0 });
  assert.deepEqual(effects.get("second"), { width: 15, height: 0 });
});

test("horizontal divider reduces glass height on both adjoining sections", () => {
  const entry = makeEntry("horizontal");
  entry.join.type = "Coupler";
  assert.equal(getJoinOrientation(entry), "horizontal");

  const effects = buildGlassDimensionEffects([entry], {
    "Casement||CS-1": {
      couplers: [{ glassDimensionEffect: 8 }],
    },
  });

  assert.deepEqual(effects.get("first"), { width: 0, height: 8 });
  assert.deepEqual(effects.get("second"), { width: 0, height: 8 });
});

test("an internal split section remains a valid join endpoint after sub-items are remapped", () => {
  const subItemIdMap = new Map([
    ["top-left", "saved-top-left"],
    ["bottom-left", "saved-bottom-left"],
    ["right", "saved-right"],
  ]);
  const layout = remapConfiguratorLayout(
    {
      id: "root",
      split: "vertical",
      children: [
        {
          id: "left-group",
          split: "horizontal",
          children: [{ id: "top-left" }, { id: "bottom-left" }],
        },
        { id: "right" },
      ],
    },
    subItemIdMap
  );
  const validLayoutIds = collectLayoutNodeIds(layout);

  assert.equal(
    resolveJoinEndpoint("left-group", subItemIdMap, validLayoutIds),
    "left-group"
  );
  assert.equal(
    resolveJoinEndpoint("right", subItemIdMap, validLayoutIds),
    "saved-right"
  );
  assert.equal(
    resolveJoinEndpoint("missing", subItemIdMap, validLayoutIds),
    ""
  );
});

test("nested split glass effect applies to persisted descendant panes, not the group id", () => {
  const topLeft = { id: "top-left", systemType: "Casement" };
  const blank = { id: "bottom-left", systemType: "Blank Area" };
  const right = { id: "right", systemType: "Casement" };
  const entry = {
    parent: {
      configuratorLayout: {
        id: "root",
        split: "vertical",
        children: [
          {
            id: "left-group",
            split: "horizontal",
            children: [{ id: "top-left" }, { id: "bottom-left" }],
          },
          { id: "right" },
        ],
      },
    },
    join: { p1: "left-group", p2: "right", type: "Coupler" },
    first: topLeft,
    second: right,
    firstItems: [topLeft, blank],
    secondItems: [right],
    systemType: "Casement",
    series: "CS-1",
  };

  assert.equal(getJoinOrientation(entry), "vertical");
  const effects = buildGlassDimensionEffects([entry], {
    "Casement||CS-1": { couplers: [{ glassDimensionEffect: 10 }] },
  });
  assert.deepEqual(effects.get("top-left"), { width: 10, height: 0 });
  assert.deepEqual(effects.get("right"), { width: 10, height: 0 });
  assert.equal(effects.has("left-group"), false);
  assert.equal(effects.has("bottom-left"), false);
});

test("width and height glass lines compile into one pane row", () => {
  const rows = compileGlassRows([
    { itemType: "profile", sapCode: "P-1", dimension: 500, quantity: 2 },
    { itemType: "glass", description: "6mm Clear", dimension: 480, quantity: 2 },
    { itemType: "glass", description: "6mm Clear", dimension: 980, quantity: 2 },
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    itemType: "glass",
    description: "6mm Clear",
    glassRef: "G1",
    dimension: "480 x 980",
    quantity: 2,
    unit: "Pcs",
    position: "G1 - Glass size",
    linkedBeading: undefined,
  });
});

test("multiple glass references compile into independent panes", () => {
  const rows = compileGlassRows([
    {
      itemType: "glass",
      glassRef: "G1",
      description: "6mm Clear",
      dimension: 450,
      dimensionAxis: "width",
      quantity: 1,
    },
    {
      itemType: "glass",
      glassRef: "G1",
      description: "6mm Clear",
      dimension: 950,
      dimensionAxis: "height",
      quantity: 1,
    },
    {
      itemType: "glass",
      glassRef: "G2",
      description: "6mm Clear",
      dimension: 300,
      dimensionAxis: "width",
      quantity: 1,
    },
    {
      itemType: "glass",
      glassRef: "G2",
      description: "6mm Clear",
      dimension: 950,
      dimensionAxis: "height",
      quantity: 1,
    },
  ]);

  assert.deepEqual(
    rows.map((row) => ({
      glassRef: row.glassRef,
      dimension: row.dimension,
      position: row.position,
    })),
    [
      { glassRef: "G1", dimension: "450 x 950", position: "G1 - Glass size" },
      { glassRef: "G2", dimension: "300 x 950", position: "G2 - Glass size" },
    ]
  );
});

test("combination panes with identical dimensions consolidate quantity", () => {
  const makeSection = (dimension) => ({
    item: { parentRefCode: "F-1" },
    rows: [
      {
        itemType: "glass",
        description: "6mm Clear",
        dimension,
        quantity: 1,
        unit: "Pcs",
      },
    ],
    notes: [],
  });
  const sections = consolidateCombinationGlassSections(
    [makeSection("480 x 980"), makeSection("480 x 980"), makeSection("500 x 980")],
    { items: [{ refCode: "F-1", width: 1500, height: 1000 }] }
  );

  assert.equal(sections.length, 1);
  assert.equal(sections[0].rows.length, 2);
  assert.equal(
    sections[0].rows.find((row) => row.dimension === "480 x 980").quantity,
    2
  );
  assert.equal(
    sections[0].rows.find((row) => row.dimension === "500 x 980").quantity,
    1
  );
});

test("combination profiles and glass share one parent fabrication section", () => {
  const sections = consolidateCombinationGlassSections(
    [
      {
        item: { parentRefCode: "W1", refCode: "W1-a" },
        rows: [
          {
            itemType: "profile",
            description: "Frame",
            sapCode: "4011001",
            dimension: 500,
            cutAngle: "45",
            quantity: 2,
            unit: "Pcs",
            position: "W",
          },
          {
            itemType: "glass",
            description: "6mm Clear Toughened",
            sapCode: "--",
            dimension: "444 x 944",
            quantity: 1,
            unit: "Pcs",
            position: "Glass size",
          },
        ],
        notes: [],
      },
      {
        item: { parentRefCode: "W1", refCode: "W1-b" },
        rows: [
          {
            itemType: "profile",
            description: "Frame",
            sapCode: "4011001",
            dimension: 500,
            cutAngle: "45",
            quantity: 2,
            unit: "Pcs",
            position: "W",
          },
          {
            itemType: "glass",
            description: "6mm Clear Toughened",
            sapCode: "--",
            dimension: "444 x 944",
            quantity: 1,
            unit: "Pcs",
            position: "Glass size",
          },
        ],
        notes: [],
      },
    ],
    {
      items: [
        {
          refCode: "W1",
          systemType: "Combination",
          width: 1000,
          height: 1000,
        },
      ],
    }
  );

  assert.equal(sections.length, 1);
  assert.equal(sections[0].item.refCode, "W1");
  assert.equal(sections[0].rows.length, 2);
  assert.equal(
    sections[0].rows.find((row) => row.itemType === "profile").quantity,
    4
  );
  assert.equal(
    sections[0].rows.find((row) => row.itemType === "glass").quantity,
    2
  );
});

test("combination rows retain whole-frame variables and split ratios", () => {
  const rows = itemRowsForSchedule({
    items: [
      {
        refCode: "W1",
        systemType: "Combination",
        width: 1200,
        height: 1000,
        quantity: 2,
        configuratorLayout: {
          id: "root",
          children: [
            { id: "left", x: 0, y: 0, w: 0.4, h: 1 },
            { id: "right", x: 0.4, y: 0, w: 0.6, h: 1 },
          ],
        },
        subItems: [
          { id: "left", refCode: "W1-a", width: 1200, height: 1000 },
          { id: "right", refCode: "W1-b", width: 1200, height: 1000 },
        ],
      },
    ],
  });

  assert.deepEqual(
    rows.map((row) => ({
      refCode: row.refCode,
      width: row.width,
      height: row.height,
      frameWidth: row.frameWidth,
      frameHeight: row.frameHeight,
      widthRatio: row.subFrameWidthRatio,
      heightRatio: row.subFrameHeightRatio,
      quantity: row.quantity,
    })),
    [
      {
        refCode: "W1-a",
        width: 480,
        height: 1000,
        frameWidth: 1200,
        frameHeight: 1000,
        widthRatio: 0.4,
        heightRatio: 1,
        quantity: 2,
      },
      {
        refCode: "W1-b",
        width: 720,
        height: 1000,
        frameWidth: 1200,
        frameHeight: 1000,
        widthRatio: 0.6,
        heightRatio: 1,
        quantity: 2,
      },
    ]
  );
});

test("cutting schedule displays selected frame and shutter cut angles", () => {
  assert.deepEqual(
    getDisplayCutAngles({
      item: { frameCutAngle: "45", shutterCutAngle: "45" },
      horizontalAngle: "",
      verticalAngle: "",
    }),
    { frame: "45", shutter: "45" }
  );
});

test("vertical joins use only W formulas and horizontal joins use only H formulas", () => {
  const config = {
    mullions: [
      { sapCode: "H-LINE", formula: "H - 50", quantity: 1 },
      { sapCode: "W-LINE", formula: "W - 50", quantity: 1 },
    ],
  };
  const vertical = makeEntry("vertical");
  const horizontal = makeEntry("horizontal");

  assert.deepEqual(
    getJoinLinesForOrientation(vertical, config).map((line) => line.sapCode),
    ["W-LINE"]
  );
  assert.deepEqual(
    getJoinLinesForOrientation(horizontal, config).map((line) => line.sapCode),
    ["H-LINE"]
  );
});

test("nested join formulas use the whole frame dimensions", () => {
  const entry = {
    parent: {
      width: 1200,
      height: 1000,
      area: 12.917,
      configuratorLayout: {
        id: "root",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        split: "horizontal",
        children: [
          {
            id: "top",
            x: 0,
            y: 0,
            w: 1,
            h: 0.4,
            split: "vertical",
            children: [
              { id: "top-left", x: 0, y: 0, w: 0.5, h: 0.4 },
              { id: "top-right", x: 0.5, y: 0, w: 0.5, h: 0.4 },
            ],
          },
          { id: "bottom", x: 0, y: 0.4, w: 1, h: 0.6 },
        ],
      },
    },
    join: { p1: "top-left", p2: "top-right", type: "Mullion" },
  };

  assert.deepEqual(getJoinFormulaVariables(entry, 1), {
    W: 1200,
    H: 1000,
    Q: 1,
    AREA: 12.917,
  });
});

test("glass formula runs on whole frame before split ratio and join effect", () => {
  const variables = { W: 1000, H: 1000, Q: 1, AREA: 10.764 };
  assert.equal(
    evaluateGlassDimensionFormula("W - 56", variables, {
      widthRatio: 0.5,
      heightRatio: 1,
      widthEffect: 28,
      heightEffect: 0,
    }),
    444
  );
  assert.equal(
    evaluateGlassDimensionFormula("H - 56", variables, {
      widthRatio: 0.5,
      heightRatio: 1,
      widthEffect: 28,
      heightEffect: 0,
    }),
    944
  );
});
