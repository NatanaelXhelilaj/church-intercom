import bcrypt from "bcrypt";
import pool from "./db.js";

const SALT_ROUNDS = 10;
const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,50}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Validate username format
function validateUsername(username) {
  if (!username || typeof username !== "string") {
    return { valid: false, error: "Username is required" };
  }
  if (!USERNAME_REGEX.test(username)) {
    return {
      valid: false,
      error: "Username must be 3-50 characters and contain only letters, numbers, underscores, or hyphens",
    };
  }
  return { valid: true };
}

// Validate email format
function validateEmail(email) {
  if (!email || typeof email !== "string") {
    return { valid: false, error: "Email is required" };
  }
  if (!EMAIL_REGEX.test(email)) {
    return { valid: false, error: "Invalid email format" };
  }
  return { valid: true };
}

// Validate password strength
function validatePassword(password) {
  if (!password || typeof password !== "string") {
    return { valid: false, error: "Password is required" };
  }
  if (password.length < 8) {
    return { valid: false, error: "Password must be at least 8 characters" };
  }
  if (password.length > 128) {
    return { valid: false, error: "Password must be less than 128 characters" };
  }
  return { valid: true };
}

// Validate display name
function validateDisplayName(displayName) {
  if (!displayName || typeof displayName !== "string") {
    return { valid: false, error: "Display name is required" };
  }
  const trimmed = displayName.trim();
  if (trimmed.length < 1 || trimmed.length > 60) {
    return { valid: false, error: "Display name must be 1-60 characters" };
  }
  return { valid: true, sanitized: trimmed.replace(/\s+/g, " ") };
}

// Register a new user
export async function registerUser(username, email, password, displayName, isAdmin = false) {
  const usernameValidation = validateUsername(username);
  if (!usernameValidation.valid) {
    throw new Error(usernameValidation.error);
  }

  const emailValidation = validateEmail(email);
  if (!emailValidation.valid) {
    throw new Error(emailValidation.error);
  }

  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    throw new Error(passwordValidation.error);
  }

  const displayNameValidation = validateDisplayName(displayName);
  if (!displayNameValidation.valid) {
    throw new Error(displayNameValidation.error);
  }

  const sanitizedDisplayName = displayNameValidation.sanitized;

  try {
    // Check if username or email already exists
    const checkQuery = "SELECT id FROM users WHERE username = $1 OR email = $2";
    const checkResult = await pool.query(checkQuery, [username.toLowerCase(), email.toLowerCase()]);

    if (checkResult.rows.length > 0) {
      throw new Error("Username or email already exists");
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Insert new user
    const insertQuery = `
      INSERT INTO users (username, email, password_hash, display_name, is_admin, is_active)
      VALUES ($1, $2, $3, $4, $5, TRUE)
      RETURNING id, username, email, display_name, is_admin, is_active, created_at
    `;

    const result = await pool.query(insertQuery, [
      username.toLowerCase(),
      email.toLowerCase(),
      passwordHash,
      sanitizedDisplayName,
      isAdmin,
    ]);

    return result.rows[0];
  } catch (error) {
    console.error("Registration error:", error.message);
    throw error;
  }
}

// Login user
export async function loginUser(usernameOrEmail, password) {
  if (!usernameOrEmail) {
    throw new Error("Username is required");
  }

  // BYPASS MODE for local development without database - no password required
  if (process.env.BYPASS_AUTH === 'true') {
    console.log('BYPASS_AUTH enabled - allowing login without database');
    return {
      id: 1,
      username: usernameOrEmail.toLowerCase(),
      email: `${usernameOrEmail.toLowerCase()}@example.com`,
      display_name: usernameOrEmail,
      is_admin: usernameOrEmail.toLowerCase().includes('admin'),
      is_active: true,
    };
  }

  try {
    // Find user by username or email
    const query = `
      SELECT id, username, email, password_hash, display_name, is_admin, is_active
      FROM users
      WHERE (username = $1 OR email = $1) AND is_active = TRUE
    `;

    const result = await pool.query(query, [usernameOrEmail.toLowerCase()]);

    if (result.rows.length === 0) {
      throw new Error("Invalid credentials");
    }

    const user = result.rows[0];

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      throw new Error("Invalid credentials");
    }

    // Update last login timestamp
    await pool.query("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1", [user.id]);

    // Return user data (without password hash)
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name,
      isAdmin: user.is_admin,
      isActive: user.is_active,
    };
  } catch (error) {
    console.error("Login error:", error.message);
    throw error;
  }
}

// Get user by ID
export async function getUserById(userId, session = null) {
  // BYPASS MODE - return user data from session
  if (process.env.BYPASS_AUTH === 'true' && session) {
    return {
      id: session.userId || 1,
      username: session.username || 'user',
      email: `${session.username || 'user'}@example.com`,
      displayName: session.displayName || session.username || 'User',
      isAdmin: session.isAdmin || false,
      isActive: true,
      createdAt: new Date(),
      lastLogin: new Date(),
    };
  }

  try {
    const query = `
      SELECT id, username, email, display_name, is_admin, is_active, created_at, last_login
      FROM users
      WHERE id = $1 AND is_active = TRUE
    `;

    const result = await pool.query(query, [userId]);

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0];
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name,
      isAdmin: user.is_admin,
      isActive: user.is_active,
      createdAt: user.created_at,
      lastLogin: user.last_login,
    };
  } catch (error) {
    console.error("Get user by ID error:", error.message);
    throw error;
  }
}

// Authentication middleware for Express
export function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

// Admin authentication middleware
export function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  if (!req.session.isAdmin) {
    return res.status(403).json({ error: "Admin privileges required" });
  }
  next();
}

// Socket.IO authentication middleware
export async function authenticateSocket(socket, next) {
  const session = socket.request.session;

  if (!session || !session.userId) {
    return next(new Error("Authentication required"));
  }

  try {
    // Pass session for BYPASS_AUTH mode
    const user = await getUserById(session.userId, session);
    if (!user || !user.isActive) {
      return next(new Error("User not found or inactive"));
    }

    // Attach user info to socket
    socket.data.userId = user.id;
    socket.data.username = user.username;
    socket.data.displayName = user.displayName;
    socket.data.isAdmin = user.isAdmin;

    next();
  } catch (error) {
    console.error("Socket authentication error:", error.message);
    next(new Error("Authentication failed"));
  }
}
