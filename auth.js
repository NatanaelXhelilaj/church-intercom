import bcrypt from "bcrypt";
import pool from "./db.js";
import config from "./config.js";

const SALT_ROUNDS = 10;

/**
 * A bcrypt hash of a value nobody knows, compared against when a username does
 * not exist. Without this, a missing user returns noticeably faster than a
 * wrong password and the login endpoint becomes a username oracle.
 */
const DUMMY_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,50}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Admin usernames must say so: "admin", "admin2", "sound-admin" all pass. */
const ADMIN_USERNAME_REGEX = /admin/i;

/**
 * The single place that decides whether someone gets the admin surface.
 *
 * Two conditions, both required: the database flag, and "admin" in the
 * username. The username rule can only ever take privilege away — it is a
 * filter over is_admin, never a grant — so an account cannot become an admin
 * merely by being named one.
 *
 * Every path that reports isAdmin goes through here. Admin rights gate real
 * capability (kicking people out of a room, taking over the building's
 * speakers, repointing the server's sound card), so a client-side check is
 * decoration; this is the check that counts.
 */
export function resolveAdmin(username, isAdminFlag) {
  return !!isAdminFlag && ADMIN_USERNAME_REGEX.test(String(username || ""));
}

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

  // Refuse the combination outright rather than storing an is_admin flag that
  // resolveAdmin() will silently ignore at every login. A half-privileged
  // account is far more confusing to debug than a rejected form.
  if (isAdmin && !ADMIN_USERNAME_REGEX.test(username)) {
    throw new Error(
      'An administrator\'s username must contain "admin" (for example "admin" or "sound-admin")'
    );
  }

  const sanitizedDisplayName = displayNameValidation.sanitized;

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const insertQuery = `
    INSERT INTO users (username, email, password_hash, display_name, is_admin, is_active)
    VALUES ($1, $2, $3, $4, $5, TRUE)
    RETURNING id, username, email, display_name, is_admin, is_active, created_at
  `;

  try {
    const result = await pool.query(insertQuery, [
      username.toLowerCase(),
      email.toLowerCase(),
      passwordHash,
      sanitizedDisplayName,
      isAdmin,
    ]);

    return result.rows[0];
  } catch (error) {
    // Let the UNIQUE constraint decide, rather than a SELECT-then-INSERT that
    // two concurrent registrations can both pass.
    if (error.code === "23505") {
      throw new Error("Username or email already exists");
    }
    console.error("Registration error:", error.message);
    throw error;
  }
}

// Login user
export async function loginUser(usernameOrEmail, password) {
  if (!usernameOrEmail || typeof usernameOrEmail !== "string") {
    throw new Error("Invalid credentials");
  }

  // Development-only escape hatch. config.js refuses to boot with this enabled
  // under NODE_ENV=production, so it cannot reach a deployed install.
  if (config.auth.bypass) {
    console.warn("BYPASS_AUTH is enabled - accepting login without verification");
    return {
      id: 1,
      username: usernameOrEmail.toLowerCase(),
      email: `${usernameOrEmail.toLowerCase()}@example.com`,
      displayName: usernameOrEmail,
      isAdmin: resolveAdmin(usernameOrEmail, true),
      isActive: true,
    };
  }

  if (!password || typeof password !== "string") {
    throw new Error("Invalid credentials");
  }

  const query = `
    SELECT id, username, email, password_hash, display_name, is_admin, is_active
    FROM users
    WHERE (username = $1 OR email = $1) AND is_active = TRUE
  `;

  const result = await pool.query(query, [usernameOrEmail.toLowerCase()]);
  const user = result.rows[0];

  // Always run a comparison, even for an unknown username, so response timing
  // does not reveal which accounts exist.
  const passwordMatch = await bcrypt.compare(
    password,
    user ? user.password_hash : DUMMY_HASH
  );

  if (!user || !passwordMatch) {
    throw new Error("Invalid credentials");
  }

  // Best-effort: a failed timestamp write must not block a valid login.
  pool
    .query("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1", [user.id])
    .catch((error) => console.warn("Could not record last_login:", error.message));

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.display_name,
    isAdmin: resolveAdmin(user.username, user.is_admin),
    isActive: user.is_active,
  };
}

/**
 * Creates the first administrator on an empty database.
 *
 * Replaces the previous approach of seeding a fixed `admin` / `admin123`
 * account from database.sql with a published bcrypt hash. Runs on every boot
 * but does nothing once any admin exists, so it is safe to leave enabled.
 */
export async function bootstrapAdminUser() {
  if (config.auth.bypass) return;

  const existing = await pool.query(
    "SELECT id FROM users WHERE is_admin = TRUE LIMIT 1"
  );
  if (existing.rows.length > 0) return;

  const { bootstrapAdminUsername, bootstrapAdminPassword, bootstrapAdminEmail } =
    config.auth;

  if (!bootstrapAdminPassword) {
    console.warn(
      "\nNo administrator account exists and BOOTSTRAP_ADMIN_PASSWORD is unset.\n" +
        "Set it in .env and restart to create the first admin account.\n"
    );
    return;
  }

  // Caught here rather than left to blow up the boot: a misnamed
  // BOOTSTRAP_ADMIN_USERNAME is a config typo, not a reason to refuse to run
  // an intercom that otherwise works for everyone else.
  if (!ADMIN_USERNAME_REGEX.test(bootstrapAdminUsername)) {
    console.warn(
      `\nBOOTSTRAP_ADMIN_USERNAME "${bootstrapAdminUsername}" does not contain "admin",\n` +
        "so it cannot hold administrator rights. No admin account was created.\n" +
        'Rename it (for example "admin") and restart.\n'
    );
    return;
  }

  await registerUser(
    bootstrapAdminUsername,
    bootstrapAdminEmail,
    bootstrapAdminPassword,
    bootstrapAdminUsername,
    true
  );

  console.log(`Created initial administrator account "${bootstrapAdminUsername}"`);
}

// Get user by ID
export async function getUserById(userId, session = null) {
  // BYPASS MODE - return user data from session
  if (config.auth.bypass && session) {
    return {
      id: session.userId || 1,
      username: session.username || 'user',
      email: `${session.username || 'user'}@example.com`,
      displayName: session.displayName || session.username || 'User',
      isAdmin: resolveAdmin(session.username, session.isAdmin),
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
      isAdmin: resolveAdmin(user.username, user.is_admin),
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
  // Re-derived rather than trusting session.isAdmin on its own: sessions live
  // for 30 days, so one issued before the username rule existed would still be
  // carrying an isAdmin flag that the rule would now refuse.
  if (!resolveAdmin(req.session.username, req.session.isAdmin)) {
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
    // getUserById already applied the rule; re-stating it keeps the socket
    // surface (kick, playback, device selection) safe if that ever changes.
    socket.data.isAdmin = resolveAdmin(user.username, user.isAdmin);

    next();
  } catch (error) {
    console.error("Socket authentication error:", error.message);
    next(new Error("Authentication failed"));
  }
}
