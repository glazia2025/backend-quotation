import mongoose from "mongoose";
import Quotation from "../models/Quotation/Quotation.js";

export const getChartData=async(req,res)=>{
    try{
        const userId=req.params.userId;
        const year=req.query.year;

        const startDate=`${year}-01-01`;
        const endDate=`${Number(year) + 1}-01-01`;

       const data = await Quotation.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(userId),
          "quotationDetails.date": {
            $gte: startDate,
            $lt: endDate
          },
           "quotationDetails.opportunity": { $ne: "" }
        }
      },
      {
        $project: {
          monthNumber: {
            $month: { $toDate: "$quotationDetails.date" }
          },
         stage: {
  $cond: {
    if: { $ne: ["$quotationDetails.opportunity", ""] },
    then: {
      $replaceAll: {
        input: { $toLower: "$quotationDetails.opportunity" },
        find: " ",
        replacement: "_"
      }
    },
    else: "unknown"
  }
}
        }
      },
      {
        $addFields: {
          month: {
            $arrayElemAt: [
              ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
              { $subtract: ["$monthNumber", 1] }
            ]
          }
        }
      },
      {
        $group: {
          _id: { month: "$month", stage: "$stage" },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: "$_id.month",
          stages: {
            $push: { k: "$_id.stage", v: "$count" }
          }
        }
      },
      {
        $project: {
          _id: 0,
          month: "$_id",
          data: { $arrayToObject: "$stages" }
        }
      }
    ]);
    res.json(data);
    }
    catch(err){
        console.log(err);
        res.status(500).json({error:err.message})

    }
};
export const getDashboardStats = async (req, res) => {
  try {
    const userId = req.params.userId;
    const year = req.query.year;

    const startDate = new Date(`${year}-01-01`);
    const endDate = new Date(`${Number(year) + 1}-01-01`);

    const result = await Quotation.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(userId),
          $expr: {
            $and: [
              {
                $gte: [
                  { $toDate: "$quotationDetails.date" },
                  startDate
                ]
              },
              {
                $lt: [
                  { $toDate: "$quotationDetails.date" },
                  endDate
                ]
              }
            ]
          }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          confirmed: {
            $sum: {
              $cond: [
                { $eq: ["$quotationDetails.opportunity", "Order Confirmed"] },
                1,
                0
              ]
            }
          },
          revenue: {
            $sum: "$breakdown.totalAmount"
          }
        }
      }
    ]);

    res.json(result[0] || { total: 0, confirmed: 0, revenue: 0 });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
};