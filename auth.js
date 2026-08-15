import pool from "./db.js";
import config from "./config.js";

/**
 * Sign-in is passwordless: the username *is* the credential.
 *
 * This is a deliberate trade for a device that lives on one church LAN and is
 * used by volunteers who are already in the building. It also means the admin
 * surface — kicking people from a room, taking over the building's speakers,
 * repointing the server's sound card — is reachable by anyone on that LAN who
 * types an admin username. Treat network access to this appliance as
 * equivalent to admin access, and keep it off any untrusted network.
 *
 * password_hash is still NOT NULL in the schema, so accounts are written with
 * this sentinel. It is not a bcrypt hash and never will be: nothing compares
 * against it, and if a comparison path ever came back it could not match.
 */
const PASSWORDLESS_SENTINEL = "!passwordless";
const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,50}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The single place that decides whether someone gets the admin surface.
 *
 * Two separate things, both required:
 *
 *   accountIsAdmin  — the `users.is_admin` column. The *capability*: whether
 *                     this account is allowed to administer anything at all.
 *   requestedAdmin  — the "Sign in as administrator" checkbox. The *intent*:
 *                     whether this particular session asked to use it.
 *
 * Intent can only ever take privilege away. Ticking the box on an account
 * without the flag grants nothing, so the checkbox is not a way to self-
 * promote; it only lets an admin choose to spend a session as an ordinary
 * user, which is what you want when a volunteer borrows the tablet.
 *
 * The database flag used to be paired with an "admin" substring in the
 * username instead. That rule is gone: it forced administrators into a naming
 * convention, and once sign-in went passwordless it meant the username alone
 * both identified and elevated you.
 *
 * Every path that reports isAdmin goes through here. Admin rights gate real
 * capability (kicking people out of a room, taking over the building's
 * speakers, repointing the server's sound card), so a client-side check is
 * decoration; this is the check that counts.
 */
export function resolveAdmin(accountIsAdmin, requestedAdmin) {
  return !!accountIsAdmin && !!requestedAdmin;
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
export async function registerUser(username, email, displayName, isAdmin = false) {
  const usernameValidation = validateUsername(username);
  if (!usernameValidation.valid) {
    throw new Error(usernameValidation.error);
  }

  const emailValidation = validateEmail(email);
  if (!emailValidation.valid) {
    throw new Error(emailValidation.error);
  }

  const displayNameValidation = validateDisplayName(displayName);
  if (!displayNameValidation.valid) {
    throw new Error(displayNameValidation.error);
  }

  const sanitizedDisplayName = displayNameValidation.sanitized;

  const insertQuery = `
    INSERT INTO users (username, email, password_hash, display_name, is_admin, is_active)
    VALUES ($1, $2, $3, $4, $5, TRUE)
    RETURNING id, username, email, display_name, is_admin, is_active, created_at
  `;

  try {
    const result = await pool.query(insertQuery, [
      username.toLowerCase(),
      email.toLowerCase(),
      PASSWORDLESS_SENTINEL,
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

/** Thrown when a non-admin account ticks "Sign in as administrator". */
export class NotAnAdminError extends Error {
  constructor() {
    super("This account is not an administrator");
    this.name = "NotAnAdminError";
  }
}


/**
 * Signs someone in from their username alone.
 *
 * The account must still exist and be active — this is "pick who you are from
 * the roster", not "type anything". Deactivating a user in the database is
 * therefore the only way to revoke access, since there is no password to
 * change. See PASSWORDLESS_SENTINEL for what this trade costs.
 *
 * The timing-safe dummy comparison the password path used is gone with it.
 * Nothing is left to hide: when the username is the credential, confirming
 * that an account exists is confirming the credential, and no amount of
 * constant-time work changes that.
 *
 * `requestedAdmin` is the checkbox on the sign-in form. Asking for admin
 * without the database flag is refused outright rather than quietly downgraded
 * — someone who ticks that box is about to go looking for controls, and
 * silently handing them an ordinary session sends them hunting through the UI
 * for buttons that were never going to appear.
 */
export async function loginUser(usernameOrEmail, requestedAdmin = false) {
  if (!usernameOrEmail || typeof usernameOrEmail !== "string") {
    throw new Error("Username is required");
  }

  // Development-only escape hatch, and how the appliance actually runs: it
  // needs no database at all, so it accepts any username rather than checking
  // a roster it cannot read, and — having no is_admin column to consult —
  // treats every account as admin-capable. On such an install the checkbox is
  // the whole of the admin decision. That is deliberate: the box sits on a
  // church LAN with no route in from outside.
  if (config.auth.bypass) {
    console.warn("BYPASS_AUTH is enabled - accepting any username");
    return {
      id: 1,
      username: usernameOrEmail.toLowerCase(),
      email: `${usernameOrEmail.toLowerCase()}@example.com`,
      displayName: usernameOrEmail,
      isAdmin: resolveAdmin(true, requestedAdmin),
      isActive: true,
    };
  }

  const query = `
    SELECT id, username, email, display_name, is_admin, is_active
    FROM users
    WHERE (username = $1 OR email = $1) AND is_active = TRUE
  `;

  const result = await pool.query(query, [usernameOrEmail.toLowerCase()]);
  const user = result.rows[0];

  if (!user) {
    throw new Error("Unknown username");
  }

  if (requestedAdmin && !user.is_admin) {
    throw new NotAnAdminError();
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
    isAdmin: resolveAdmin(user.is_admin, requestedAdmin),
    isActive: user.is_active,
  };
}

/**
 * Creates the first administrator on an empty database.
 *
 * Replaces the previous approach of seeding a fixed `admin` / `admin123`
 * account from database.sql with a published bcrypt hash. Runs on every boot
 * but does nothing once any admin exists, so it is safe to leave enabled.
 *
 * Since sign-in is passwordless this needs no secret to run, which means a
 * fresh install always ends up with a reachable admin account rather than
 * warning and leaving nobody able to administer the box.
 */
export async function bootstrapAdminUser() {
  if (config.auth.bypass) return;

  const existing = await pool.query(
    "SELECT id FROM users WHERE is_admin = TRUE LIMIT 1"
  );
  if (existing.rows.length > 0) return;

  // BOOTSTRAP_ADMIN_USERNAME may now be anything a username may be: admin
  // rights come from the is_admin column and the checkbox, not from the name.
  const { bootstrapAdminUsername, bootstrapAdminEmail } = config.auth;

  await registerUser(
    bootstrapAdminUsername,
    bootstrapAdminEmail,
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
      isAdmin: resolveAdmin(true, session.isAdmin),
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
      // The capability is re-read from the database on every call, so removing
      // someone's is_admin flag takes effect on their next request rather than
      // whenever their 30-day session happens to expire. The intent comes from
      // the session, which is where the checkbox recorded it at sign-in.
      isAdmin: resolveAdmin(user.is_admin, session?.isAdmin),
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
//
// Confirms the account still holds is_admin rather than trusting the flag the
// session has been carrying since login. Sessions live for 30 days; without
// this, revoking someone's admin rights would not bite until theirs expired.
export async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }

  // Cheap rejection first: no admin session, no database round trip.
  if (!req.session.isAdmin) {
    return res.status(403).json({ error: "Admin privileges required" });
  }

  try {
    const user = await getUserById(req.session.userId, req.session);
    if (!user?.isAdmin) {
      return res.status(403).json({ error: "Admin privileges required" });
    }
    next();
  } catch (error) {
    console.error("Admin check failed:", error.message);
    res.status(500).json({ error: "Could not verify privileges" });
  }
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
    // Already the resolved capability-and-intent answer: getUserById combined
    // the account's is_admin with the session's checkbox. This is what guards
    // the socket surface — kick, playback, device selection.
    socket.data.isAdmin = user.isAdmin;

    next();
  } catch (error) {
    console.error("Socket authentication error:", error.message);
    next(new Error("Authentication failed"));
  }
}
