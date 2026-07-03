const mongoose = require("mongoose");
const beadingSchema=new mongoose.Schema(
    {
        sapCode:{
            type:String,
            trim:true,
            default:"",
        },
         description:{
        type:String,
        trim:true,
        default:"",
    },
        formula:{
            type:String,
            trim:true,
            default:"",
        },
        quantity:{
            type:Number,
            default:1,

        },
    },
    {_id:true}
);

const gasketSchema = new mongoose.Schema(
    {
        sapCode:{
            type:String,
            trim:true,
            default:"",
        },
         description:{
        type:String,
        trim:true,
        default:"",
    },
        formula:{
            type:String,
            trim:true,
            default:"",
        },
    },
    { _id:true}
);
const glassBeadingConfigSchema =new mongoose.Schema(
    {
        glassSpec:{
            type:String,
            required:true,
            trim:true,
        },

        systemType:{
            type:String,
            required:true,
            trim:true,
        },
        series:{
            type:String,
            required:true,
            trim:true,
        },
        description:{
            type:String,
            required:true,
            trim:true,
        },
        beadings:{
            type:[beadingSchema],
            default:[],
        },
        gaskets:{
            type:[gasketSchema],
            default:[],
        },
},
{
    timestamps:true,
}
);

glassBeadingConfigSchema.index(
  {
    systemType: 1,
    series: 1,
    description: 1,
    glassSpec: 1,
  },
  {
    unique: true,
  }
);
module.exports=mongoose.model(
    "GlassBeadingConfig",
    glassBeadingConfigSchema
);