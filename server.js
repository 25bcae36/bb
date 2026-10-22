const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const app = express();
const scrypt = promisify(crypto.scrypt);
const PORT = Number(process.env.PORT || 3000);
const API_TOKEN = process.env.BORROWBOX_API_KEY || 'borrowbox-demo-key';
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
const pool = new Pool(databaseUrl ? {
  connectionString: databaseUrl,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 1,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
} : {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || 'borrowbox',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireApiAuth(req, res) {
  const auth = req.get('Authorization') || req.get('x-borrowbox-api-key') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (token === API_TOKEN) return true;
  res.status(401).json({ success: false, error: 'Authentication required.' });
  return false;
}

const emptyState = { users: {}, items: [], requests: [], history: [], reports: [] };
let schemaReady;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`CREATE TABLE IF NOT EXISTS borrowbox_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS borrowbox_users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      dept TEXT NOT NULL DEFAULT 'Student',
      joined DATE NOT NULL DEFAULT CURRENT_DATE,
      suspended BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(error => { schemaReady = null; throw error; });
  }
  return schemaReady;
}
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health') return next();
  if (!requireApiAuth(req, res)) return;
  if (!databaseUrl && !process.env.PGHOST) {
    return res.status(503).json({ success: false, error: 'Set DATABASE_URL in the Vercel project environment variables.' });
  }
  try { await ensureSchema(); next(); }
  catch (error) {
    console.error('PostgreSQL setup failed:', error.message);
    res.status(503).json({ success: false, error: 'PostgreSQL is unavailable. Check DATABASE_URL.' });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ success: true, database: 'PostgreSQL' });
  } catch (error) {
    res.status(503).json({ success: false, error: 'PostgreSQL is unavailable.' });
  }
});

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
function validStudentEmail(email) {
  return /^[^@\s]+@kristujayanti\.com$/.test(email);
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [algorithm, saltHex, keyHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !/^[0-9a-f]{32}$/i.test(saltHex || '') || !/^[0-9a-f]{128}$/i.test(keyHex || '')) return false;
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(keyHex, 'hex'));
}
function publicUser(row) {
  return {
    email: row.email,
    name: row.name,
    role: row.role,
    dept: row.dept,
    joined: row.joined instanceof Date ? row.joined.toISOString().slice(0, 10) : String(row.joined).slice(0, 10),
    suspended: Boolean(row.suspended)
  };
}
async function getLegacyUser(email) {
  const { rows } = await pool.query("SELECT state->'users'-> $1 AS user FROM borrowbox_state WHERE id = 1", [email]);
  return rows[0]?.user || null;
}
async function clearLegacyPassword(email) {
  await pool.query(
    `UPDATE borrowbox_state
     SET state = jsonb_set(state, ARRAY['users', $1, 'password'], 'null'::jsonb, FALSE), updated_at = NOW()
     WHERE id = 1`,
    [email]
  );
}
function validPassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 200;
}

app.post('/api/auth/register', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const password = req.body?.password;
  if (!validStudentEmail(email)) return res.status(400).json({ success: false, error: 'Use your @kristujayanti.com student email.' });
  if (name.length < 2 || name.length > 50) return res.status(400).json({ success: false, error: 'Enter a name between 2 and 50 characters.' });
  if (!validPassword(password)) return res.status(400).json({ success: false, error: 'Use a password with 6 to 200 characters.' });
  try {
    const legacyUser = await getLegacyUser(email);
    if (legacyUser?.password) return res.status(409).json({ success: false, error: 'An account already exists for this email. Log in instead.' });
    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO borrowbox_users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING email, name, role, dept, joined, suspended`,
      [email, name, passwordHash]
    );
    res.status(201).json({ success: true, user: publicUser(rows[0]) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'An account already exists for this email. Log in instead.' });
    console.error('Account registration failed:', error.message);
    res.status(500).json({ success: false, error: 'Could not create your account. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!validStudentEmail(email) || typeof password !== 'string' || !password) {
    return res.status(401).json({ success: false, error: 'That email and password do not match an account.' });
  }
  try {
    let { rows } = await pool.query(
      'SELECT email, name, password_hash, role, dept, joined, suspended FROM borrowbox_users WHERE email = $1',
      [email]
    );
    if (!rows[0]) {
      const legacyUser = await getLegacyUser(email);
      if (!legacyUser || typeof legacyUser.password !== 'string' || legacyUser.password !== password) {
        return res.status(401).json({ success: false, error: 'That email and password do not match an account.' });
      }
      const passwordHash = await hashPassword(password);
      await pool.query(
        `INSERT INTO borrowbox_users (email, name, password_hash, role, dept, joined, suspended)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (email) DO NOTHING`,
        [email, legacyUser.name || email.split('@')[0], passwordHash, legacyUser.role || 'student', legacyUser.dept || 'Student', legacyUser.joined || new Date().toISOString().slice(0, 10), Boolean(legacyUser.suspended)]
      );
      await clearLegacyPassword(email);
      ({ rows } = await pool.query(
        'SELECT email, name, password_hash, role, dept, joined, suspended FROM borrowbox_users WHERE email = $1',
        [email]
      ));
    }
    const user = rows[0];
    if (!await verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'That email and password do not match an account.' });
    }
    const legacyUser = await getLegacyUser(email);
    if (user.suspended || legacyUser?.suspended) {
      return res.status(403).json({ success: false, error: 'This account has been suspended. Contact the campus admin.' });
    }
    const profile = legacyUser ? {
      ...publicUser(user),
      name: legacyUser.name || user.name,
      role: legacyUser.role || user.role,
      dept: legacyUser.dept || user.dept,
      joined: legacyUser.joined || publicUser(user).joined
    } : publicUser(user);
    res.json({ success: true, user: profile });
  } catch (error) {
    console.error('Account login failed:', error.message);
    res.status(500).json({ success: false, error: 'Could not log in. Please try again.' });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const currentPassword = req.body?.currentPassword;
  const nextPassword = req.body?.nextPassword;
  if (!validStudentEmail(email) || typeof currentPassword !== 'string' || !currentPassword) {
    return res.status(400).json({ success: false, error: 'Enter your current password.' });
  }
  if (!validPassword(nextPassword)) return res.status(400).json({ success: false, error: 'Use a new password with 6 to 200 characters.' });
  try {
    let { rows } = await pool.query('SELECT password_hash FROM borrowbox_users WHERE email = $1', [email]);
    if (!rows[0]) {
      const legacyUser = await getLegacyUser(email);
      if (legacyUser?.password !== currentPassword) return res.status(400).json({ success: false, error: 'Your current password is not correct.' });
      const passwordHash = await hashPassword(currentPassword);
      await pool.query(
        `INSERT INTO borrowbox_users (email, name, password_hash)
         VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
        [email, legacyUser.name || email.split('@')[0], passwordHash]
      );
      await clearLegacyPassword(email);
      ({ rows } = await pool.query('SELECT password_hash FROM borrowbox_users WHERE email = $1', [email]));
    }
    if (!await verifyPassword(currentPassword, rows[0].password_hash)) {
      return res.status(400).json({ success: false, error: 'Your current password is not correct.' });
    }
    await pool.query('UPDATE borrowbox_users SET password_hash = $1 WHERE email = $2', [await hashPassword(nextPassword), email]);
    res.json({ success: true });
  } catch (error) {
    console.error('Password update failed:', error.message);
    res.status(500).json({ success: false, error: 'Could not update your password. Please try again.' });
  }
});

app.get('/api/state', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT state FROM borrowbox_state WHERE id = 1');
    res.json({ success: true, state: rows[0]?.state || null });
  } catch (error) {
    console.error('Could not read shared state:', error.message);
    res.status(500).json({ success: false, error: 'Could not load shared data.' });
  }
});

app.get('/api/items', async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT state->'items' AS items FROM borrowbox_state WHERE id = 1");
    res.json({ success: true, items: rows[0]?.items || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Could not load listings.' });
  }
});

app.put('/api/state', async (req, res) => {
  const state = req.body?.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return res.status(400).json({ success: false, error: 'A valid state object is required.' });
  }
  const normalized = {
    ...emptyState,
    users: state.users && typeof state.users === 'object' ? state.users : {},
    items: Array.isArray(state.items) ? state.items : [],
    requests: Array.isArray(state.requests) ? state.requests : [],
    history: Array.isArray(state.history) ? state.history : [],
    reports: Array.isArray(state.reports) ? state.reports : []
  };
  try {
    await pool.query(
      `INSERT INTO borrowbox_state (id, state, updated_at) VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [JSON.stringify(normalized)]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Could not save shared state:', error.message);
    res.status(500).json({ success: false, error: 'Could not save shared data.' });
  }
});

module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => console.log(`BorrowBox API running at http://localhost:${PORT}`));
}
