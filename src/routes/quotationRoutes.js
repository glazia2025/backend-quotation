const express = require("express");
const router = express.Router();
const isUser = require("../middleware/userMiddleware");
const BaseRate = require("../models/Quotation/BaseRate");
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
});

const {
  getSystems,
  getSeries,
  getDescriptions,
  getOptionLists,
  calculateRate,
  createQuotation,
  listQuotations,
  getQuotationById,
  updateQuotationById,
  deleteQuotationById,
  generateQuotationPdfController,
   generateElevationPdfController,
   exportQuotationExcel,
   importQuotationExcel
} = require("../controllers/quotationController");
const {
  getBomData,
  getOptimizedFinal,
  generateBomPdf,
  generateCuttingSchedulePdf,
} = require("../controllers/cuttingScheduleController");
const {
  bulkUpdateQuotationItems,
  createQuotationItem,
  deleteQuotationItem,
  reorderQuotationItems,
  updateQuotationItem,
} = require("../controllers/quotationItemController");

const {
  getQuotationConfig,
  createOrUpdateQuotationConfig,
} = require("../controllers/quotationConfig");

const {getChartData,getDashboardStats}=require("../controllers/chartController");

router.get("/systems", getSystems);
router.get("/systems/:systemType/series", getSeries);
router.get(
  "/systems/:systemType/series/:series/descriptions",
  getDescriptions
);
router.get("/louvers/rates", async (req, res) => {
  try {
    const baseRateDoc = await BaseRate.findOne({ systemType: "Louvers" }).lean();

    return res.json({
      rates: baseRateDoc?.rates || [0, 0, 0],
    });
  } catch (err) {
    return res.status(500).json({ message: "Error fetching louvers rates" });
  }
});
router.get("/options", getOptionLists);
router.post("/calculate-rate", isUser, calculateRate);
router.post("/", isUser, createQuotation);
router.get("/", isUser, listQuotations);
router.get("/config", isUser, getQuotationConfig);
router.post("/config", isUser, createOrUpdateQuotationConfig);

router.post("/:id/items", isUser, createQuotationItem);
router.patch("/:id/items/reorder", isUser, reorderQuotationItems);
router.patch("/:id/items/bulk-update", isUser, bulkUpdateQuotationItems);
router.patch("/:id/items/:itemId", isUser, updateQuotationItem);
router.delete("/:id/items/:itemId", isUser, deleteQuotationItem);
router.get("/:id", isUser, getQuotationById);
router.post("/:id", isUser, updateQuotationById);
router.delete("/:id", isUser, deleteQuotationById);
router.get("/:id/pdf", isUser, generateQuotationPdfController);
router.get("/:id/elevation-pdf", isUser, generateElevationPdfController);
router.get("/:id/export-excel", isUser, exportQuotationExcel);
// router.post(
//   "/:id/import-excel",
//   isUser,
//   upload.single("file"),
//   importQuotationExcel
// );
router.get("/:id/bom", isUser, generateBomPdf);
router.get("/:id/bom-data", isUser, getBomData);
router.get("/:id/optimized-final", isUser, getOptimizedFinal);
router.get("/:id/cutting-schedule", isUser, generateCuttingSchedulePdf);
router.get("/chart/:userId",getChartData);
router.get("/stats/:userId", getDashboardStats);


module.exports = router;
