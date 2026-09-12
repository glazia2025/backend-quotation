const { extractAuthToken } = require('../utils/authCookies');
const { verifyJwt } = require('../utils/jwt');
const User = require('../models/User');
require('dotenv').config();

const isUser = async (req, res, next) => {
  const token = extractAuthToken(req);

  if (!token) {
    return res.status(403).json({ message: 'Access denied, token missing!' });
  }

  try {
    const decoded = verifyJwt(token);

    // Check if the user is user
    if (!['user', 'admin'].includes(decoded.role)) {
      return res.status(403).json({ message: 'Access denied, user only!' });
    }


    if (decoded.role === 'user') {
      const user = await User.findById(decoded.userId).select('name email phoneNumber disabledModules').lean();
      if (!user) return res.status(403).json({ message: 'This user account no longer exists.', code: 'USER_NOT_FOUND' });
      if (user.disabledModules?.includes('QUOTATION_ERP')) {
        return res.status(403).json({ message: 'Your access to Quotation ERP has been disabled. Contact Glazia administration.', code: 'MODULE_ACCESS_DISABLED', module: 'QUOTATION_ERP' });
      }
      req.accessUser = user;
    }

    req.user = decoded; // Attach user info to request
    next(); // Proceed to next route handler
  } catch (err) {
    return res.status(400).json({ message: 'Invalid token!' });
  }
};

module.exports = isUser;
