import mongoose from "mongoose";
import Quotation from "../models/Quotation/Quotation.js";
await mongoose.connect(
  "mongodb+srv://glaziain:Glazia%40123@glazia.elx92.mongodb.net/test"
);
// USER ID
const userId = new mongoose.Types.ObjectId("68f62f8be4cc628dd6decf65");
// STAGES
const opportunities = ["Enquiry", "Order Confirmed", "Order Lost", "Under Negotiation", "Quoted"];
const generateData = async () => {
  try {
    const data = [];

    for (let i = 0; i < 150; i++) {
     const randomDate = new Date(
  2026,
  Math.floor(Math.random() * 12),
  Math.floor(Math.random() * 28) + 1
);

const formattedDate = randomDate.toISOString().split("T")[0];

      data.push({
        user: userId,
        generatedId: "QT-" + Date.now() + "-" + i,

        customerDetails: {
          name: "Test User " + i,
          email: `test${i}@gmail.com`,
          phone: "9999999999",
          city: "Delhi"
        },

        quotationDetails: {
          opportunity:
            opportunities[Math.floor(Math.random() * opportunities.length)],
          date: formattedDate 
        },

        breakdown: {
          totalAmount: Math.floor(Math.random() * 100000) + 1000
        }
      });
    }
    await Quotation.insertMany(data);

    console.log(" 150 Quotations Inserted Successfully");
    process.exit();
  } catch (error) {
    console.log(error);
  }
};

generateData();