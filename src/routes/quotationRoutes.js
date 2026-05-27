const express = require("express");
const router = express.Router();
const isUser = require("../middleware/userMiddleware");

const {
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
  generateQuotationPdfController,
   generateElevationPdfController
} = require("../controllers/quotationController");
const {
  generateBomPdf,
  generateCuttingSchedulePdf,
} = require("../controllers/cuttingScheduleController");

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
router.get("/options", getOptionLists);
router.post("/rate-preview", previewRate);
router.post("/", isUser, createQuotation);
router.get("/", isUser, listQuotations);
router.get("/config", isUser, getQuotationConfig);
router.post("/config", isUser, createOrUpdateQuotationConfig);

router.get("/:id", isUser, getQuotationById);
router.post("/:id", isUser, updateQuotationById);
router.delete("/:id", isUser, deleteQuotationById);
router.get("/:id/pdf", isUser, generateQuotationPdfController);
router.get("/:id/elevation-pdf", isUser, generateElevationPdfController);
router.get("/:id/bom", isUser, generateBomPdf);
router.get("/:id/cutting-schedule", isUser, generateCuttingSchedulePdf);
router.get("/chart/:userId",getChartData);
router.get("/stats/:userId", getDashboardStats);

module.exports = router;
