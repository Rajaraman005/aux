/**
 * JWT Authentication Middleware.
 * Verifies access tokens and attaches user to request.
 * Supports both header and query param auth (for WebSocket upgrades).
 */
const jwt = require("jsonwebtoken");
const config = require("../config");

function authenticateToken(req, res, next) {
  // Support: Authorization: Bearer <token> OR ?token=<token>
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.query?.token;

  if (!token) {
    return res.status(401).json({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      name: decoded.name,
    };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        error: "Token expired",
        code: "TOKEN_EXPIRED",
      });
    }
    return res.status(403).json({
      error: "Invalid token",
      code: "INVALID_TOKEN",
    });
  }
}

/**
 * Verify token from raw string (for WebSocket auth).
 * Returns decoded payload or null.
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.accessSecret);
  } catch {
    return null;
  }
}

/**
 * Generate access + refresh token pair.
 */
function generateTokenPair(user) {
  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiry },
  );

  const refreshToken = jwt.sign(
    { sub: user.id, type: "refresh" },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiry },
  );

  return { accessToken, refreshToken };
}

module.exports = { authenticateToken, verifyToken, generateTokenPair };
