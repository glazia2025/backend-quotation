const mongoose = require('mongoose');
require('dotenv').config();

const dbURI = process.env.MONGO_URI || 'mongodb+srv://glaziain:Glazia%40123@glazia.elx92.mongodb.net/?retryWrites=true&w=majority&appName=glazia';

const connectDB = async () => {
  try {
    await mongoose.connect(dbURI, {
      useNewUrlParser: true, 
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected');
} catch (err) {
    console.error('Database connection error:', err);
    process.exit(1); // Exit the application if the connection fails
  }
};

module.exports = connectDB;
