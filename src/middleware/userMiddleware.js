const { extractAuthToken } = require('../utils/authCookies');
const { verifyJwt } = require('../utils/jwt');
const User = require('../models/User');
const Quotation = require('../models/Quotation/Quotation');
const { resolveAccess, permits, quotationScope, publicBusiness } = require('../utils/businessAccess');
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
      const user = await User.findById(decoded.userId).lean();
      if (!user) return res.status(403).json({ message: 'This user account no longer exists.', code: 'USER_NOT_FOUND' });
      if (user.disabledModules?.includes('QUOTATION_ERP')) {
        return res.status(403).json({ message: 'Your access to Quotation ERP has been disabled. Contact Glazia administration.', code: 'MODULE_ACCESS_DISABLED', module: 'QUOTATION_ERP' });
      }
      const access = resolveAccess(user, decoded);
      const module = decoded.accessModule === 'SURVEY_APP' ? 'SURVEY_APP' : 'QUOTATION_ERP';
      if (!access || !permits(access, module)) return res.status(403).json({ message: 'Your membership does not allow access to this module.', code: 'MODULE_ACCESS_DISABLED' });
      req.access = access;
      req.accessUser = publicBusiness(user, access);
      req.quotationScope = quotationScope(access, module);
      req.quotationAll = !req.quotationScope.createdByActor;
      if (req.params.userId && String(req.params.userId) !== access.businessId) return res.status(403).json({ message: 'Forbidden' });
      if (req.params.id) {
        if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ message: 'Invalid quotation id' });
        if (!await Quotation.exists({ _id: req.params.id, ...req.quotationScope })) return res.status(404).json({ message: 'Quotation not found or not accessible.' });
      }
    }

    req.user = decoded; // Attach user info to request
    next(); // Proceed to next route handler
  } catch (err) {
    return res.status(400).json({ message: 'Invalid token!' });
  }
};

module.exports = isUser;
