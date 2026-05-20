const { extractAuthToken } = require('../utils/authCookies');
const { verifyJwt } = require('../utils/jwt');
require('dotenv').config();

const isAdmin = (req, res, next) => {
  const token = extractAuthToken(req);

  if (!token) {
    return res.status(403).json({ message: 'Access denied, token missing!' });
  }

  try {
    // Verify JWT token
    const decoded = verifyJwt(token);

    // Check if the user is admin
    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied, admin only!' });
    }

    req.user = decoded; // Attach user info to request
    next(); // Proceed to next route handler
  } catch (err) {
    return res.status(400).json({ message: 'Invalid token!' });
  }
};

module.exports = isAdmin;
