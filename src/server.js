const express = require("express");
const cors = require("cors");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../prod.env") });

const connectDB = require("./db");

const app = express();
const PORT = process.env.PORT || 5556;

const defaultAllowedOrigins = [
  "https://glazia.in",
  "https://www.glazia.in",
  "https://quotation.glazia.in",
  "https://glazia-quotation.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
];

const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || defaultAllowedOrigins.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.set("trust proxy", 1);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(express.json({ extended: false, limit: "10mb" }));

connectDB();

const quotationRoutes = require("./routes/quotationRoutes");
const quotationAdminRoutes = require("./routes/quotationAdminRoutes");
const userQuotationDataRoutes = require("./routes/userQuotationDataRoutes");

app.use("/api/quotations", quotationRoutes);
app.use("/api/admin/quotations", quotationAdminRoutes);
app.use("/api/user/quotation-data", userQuotationDataRoutes);

app.get("/", (req, res) => {
  res.send("Glazia quotation backend is running");
});

app.get("/health", (req, res) => {
  res.json({ service: "backend-quotation", ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Glazia quotation backend running on http://localhost:${PORT}`);
});
