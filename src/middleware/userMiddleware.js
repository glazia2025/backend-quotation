const jwt = require('jsonwebtoken');
const { extractAuthToken } = require('../utils/authCookies');
require('dotenv').config();

const isUser = (req, res, next) => {
  const token = extractAuthToken(req);

  if (!token) {
    return res.status(403).json({ message: 'Access denied, token missing!' });
  }

  try {
    console.log( "token", token);
    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    console.log(decoded);

    // Check if the user is user
    if (!['user', 'admin'].includes(decoded.role)) {
      return res.status(403).json({ message: 'Access denied, user only!' });
    }


    req.user = decoded; // Attach user info to request
    next(); // Proceed to next route handler
  } catch (err) {
    return res.status(400).json({ message: 'Invalid token!' });
  }
};

module.exports = isUser;
