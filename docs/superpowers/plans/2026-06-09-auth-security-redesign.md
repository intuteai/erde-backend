# Auth & Security Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace localStorage JWT auth with HttpOnly-cookie-based access+refresh token system and add helmet security headers.

**Architecture:** Login sets two HttpOnly Secure cookies (15min access token, 7-day refresh token). A `refresh_tokens` DB table tracks per-device sessions. A 401 Axios interceptor on the frontend silently refreshes the access token, giving users a seamless 7-day session without seeing a login prompt.

**Tech Stack:** Node.js/Express, PostgreSQL (pg), jsonwebtoken, bcrypt, cookie-parser (new), helmet (new), React, Axios

---

## File Map

| Action | Path |
|---|---|
| Create | `db/migrations/001_refresh_tokens.sql` |
| Modify | `middleware/auth.js` |
| Modify | `routes/auth.js` |
| Modify | `app.js` |
| Create | `tests/auth.test.js` |
| Modify | `../ERDE_TEST-main/src/components/LoginModal.jsx` |
| Modify | `../ERDE_TEST-main/src/App.jsx` |
| Modify | `../ERDE_TEST-main/src/components/Header.jsx` |

---

## Task 1: Install Backend Dependencies

**Files:**
- Modify: `package.json` (automatic via npm)

- [ ] **Step 1: Install cookie-parser and helmet**

```bash
cd c:\Users\Rahul\OneDrive\Desktop\Projects\ERDE\ev-dashboard-backend
npm install cookie-parser helmet
```

Expected output includes: `added 2 packages` (or similar), no errors.

- [ ] **Step 2: Verify packages are in package.json**

Open `package.json` and confirm `"cookie-parser"` and `"helmet"` appear under `"dependencies"`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add cookie-parser and helmet dependencies"
```

---

## Task 2: Create DB Migration

**Files:**
- Create: `db/migrations/001_refresh_tokens.sql`

- [ ] **Step 1: Create the migrations directory and SQL file**

Create `db/migrations/001_refresh_tokens.sql` with this exact content:

```sql
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  device_info   TEXT,
  ip_address    INET,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_used_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
```

- [ ] **Step 2: Run the migration against the database**

Connect to your PostgreSQL database and run the SQL file. Using psql:

```bash
psql -U <db_user> -d <db_name> -f db/migrations/001_refresh_tokens.sql
```

Or paste the SQL directly into your DB client (pgAdmin, TablePlus, etc.).

Expected: `CREATE TABLE`, `CREATE INDEX`, `CREATE INDEX` — no errors.

- [ ] **Step 3: Verify the table exists**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'refresh_tokens';
```

Expected: 8 rows showing id, user_id, token_hash, device_info, ip_address, expires_at, created_at, last_used_at.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/001_refresh_tokens.sql
git commit -m "feat: add refresh_tokens migration"
```

---

## Task 3: Update middleware/auth.js

**Files:**
- Modify: `middleware/auth.js`

The current file reads the token only from the `Authorization` header. Update it to prefer the `access_token` cookie, falling back to the header, then the query param.

- [ ] **Step 1: Replace the full contents of middleware/auth.js**

```javascript
// middleware/auth.js
const jwt = require('jsonwebtoken');
require('dotenv').config();

function authenticateToken(req, res, next) {
  let token = null;

  // 1. Primary: HttpOnly cookie (set by login/refresh endpoints)
  if (req.cookies && req.cookies.access_token) {
    token = req.cookies.access_token;
  }

  // 2. Fallback: Authorization header (non-browser clients, CLI tools)
  if (!token) {
    const authHeader = req.header('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '').trim();
    }
  }

  // 3. Fallback: Query parameter (required for native EventSource / SSE)
  if (!token && req.query.token) {
    token = typeof req.query.token === 'string' ? req.query.token.trim() : null;
  }

  if (!token) {
    return res
      .status(401)
      .json({ error: 'Authorization token missing or malformed' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.user_id || !decoded.role) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    req.user = decoded;
    next();
  } catch (err) {
    console.warn('JWT verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authenticateToken;
```

- [ ] **Step 2: Commit**

```bash
git add middleware/auth.js
git commit -m "feat: auth middleware reads access_token cookie first"
```

---

## Task 4: Rewrite routes/auth.js

**Files:**
- Modify: `routes/auth.js`

Replace the single login route with four routes: login (rewritten), refresh (new), logout (new), me (new).

- [ ] **Step 1: Replace the full contents of routes/auth.js**

```javascript
// routes/auth.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/postgres');
const logger = require('../utils/logger');
const authenticateToken = require('../middleware/auth');
require('dotenv').config();

const router = express.Router();

const COOKIE_DEFAULTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'Strict',
};

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    logger.info(`Login attempt for email: ${email}`);

    const userResult = await db.query(
      'SELECT user_id, email, password_hash, name, role_id FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      logger.warn(`Login failed: User not found - ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      logger.warn(`Login failed: Invalid password - ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    let roleName = 'customer';
    try {
      const roleResult = await db.query(
        'SELECT role_name FROM roles WHERE role_id = $1',
        [user.role_id]
      );
      if (roleResult.rows.length > 0) {
        roleName = roleResult.rows[0].role_name;
      }
    } catch (e) {
      logger.warn(`Role lookup failed for user ${email}: ${e.message}`);
    }

    let customerId = null;
    try {
      const custResult = await db.query(
        'SELECT customer_id FROM customer_master WHERE user_id = $1 LIMIT 1',
        [user.user_id]
      );
      customerId = custResult.rows[0]?.customer_id || null;
    } catch (e) {
      logger.debug(`customer_master lookup skipped for ${email}`);
    }

    const accessToken = jwt.sign(
      {
        user_id: user.user_id,
        email: user.email,
        role: roleName,
        name: user.name || email.split('@')[0],
        customer_id: customerId,
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = crypto.randomBytes(64).toString('hex');
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        user.user_id,
        tokenHash,
        req.headers['user-agent'] || null,
        req.ip || null,
        expiresAt,
      ]
    );

    res.cookie('access_token', accessToken, {
      ...COOKIE_DEFAULTS,
      maxAge: 15 * 60 * 1000,
      path: '/',
    });

    res.cookie('refresh_token', refreshToken, {
      ...COOKIE_DEFAULTS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth',
    });

    logger.info(`Login SUCCESS: ${email} (role: ${roleName})`);

    res.json({
      user: {
        name: user.name || email.split('@')[0],
        email: user.email,
        role: roleName,
        customer_id: customerId,
      },
    });
  } catch (err) {
    logger.error(`CRITICAL Login error for ${email}: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Server error during login' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token missing' });
  }

  const tokenHash = hashToken(refreshToken);

  try {
    const result = await db.query(
      `SELECT rt.user_id, u.email, u.name, r.role_name, cm.customer_id
       FROM refresh_tokens rt
       JOIN users u ON u.user_id = rt.user_id
       JOIN roles r ON r.role_id = u.role_id
       LEFT JOIN customer_master cm ON cm.user_id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.expires_at > now()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const { user_id, email, name, role_name, customer_id } = result.rows[0];

    const accessToken = jwt.sign(
      { user_id, email, role: role_name, name, customer_id },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    await db.query(
      'UPDATE refresh_tokens SET last_used_at = now() WHERE token_hash = $1',
      [tokenHash]
    );

    res.cookie('access_token', accessToken, {
      ...COOKIE_DEFAULTS,
      maxAge: 15 * 60 * 1000,
      path: '/',
    });

    res.json({ user: { name, email, role: role_name, customer_id } });
  } catch (err) {
    logger.error(`Refresh error: ${err.message}`);
    res.status(500).json({ error: 'Server error during token refresh' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;

  if (refreshToken) {
    const tokenHash = hashToken(refreshToken);
    try {
      await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
    } catch (err) {
      logger.warn(`Logout DB cleanup failed: ${err.message}`);
    }
  }

  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/api/auth' });
  res.json({ message: 'Logged out' });
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
  const { user_id, email, role, name, customer_id } = req.user;
  res.json({ user: { user_id, email, role, name, customer_id } });
});

module.exports = router;
```

- [ ] **Step 2: Commit**

```bash
git add routes/auth.js
git commit -m "feat: cookie-based login, add refresh/logout/me endpoints"
```

---

## Task 5: Update app.js

**Files:**
- Modify: `app.js`

Add `cookie-parser` and `helmet`. Note: CORS `credentials: true` is already set in this file.

- [ ] **Step 1: Add requires at the top of app.js**

After the existing requires (around line 4), add:

```javascript
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
```

So the top of the file becomes:

```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const logger = require('./utils/logger');
```

- [ ] **Step 2: Add cookie-parser and helmet after the body parsers section**

After lines:
```javascript
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
```

Add:
```javascript
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'"],
        connectSrc: ["'self'", 'https://analytics.erdeenergy.in'],
        imgSrc:     ["'self'", 'data:'],
        styleSrc:   ["'self'", "'unsafe-inline'"],
      },
    },
    hsts:       { maxAge: 31536000, includeSubDomains: true },
    frameguard: { action: 'deny' },
    noSniff:    true,
  })
);
```

- [ ] **Step 3: Start the server and verify it starts without errors**

```bash
npm run dev
```

Expected: Server starts, no `Cannot find module` or startup errors.

- [ ] **Step 4: Quick smoke test — hit the health endpoint**

```bash
curl http://localhost:5000/health
```

Expected: `{"status":"OK","timestamp":"..."}` with response headers including `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: add cookie-parser and helmet security headers"
```

---

## Task 6: Write Backend Integration Tests

**Files:**
- Create: `tests/auth.test.js`

These tests verify the four auth endpoints end-to-end. They require the real DB to be running (uses `NODE_ENV=test`).

- [ ] **Step 1: Create tests/auth.test.js**

```javascript
// tests/auth.test.js
const request = require('supertest');
const app = require('../app');

// These tests require a real DB with a known test user.
// Set TEST_EMAIL and TEST_PASSWORD in your .env or environment.
const TEST_EMAIL    = process.env.TEST_EMAIL    || 'admin@erde.in';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'testpassword';

describe('POST /api/auth/login', () => {
  it('returns 400 when email or password missing', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: TEST_EMAIL });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 401 for wrong credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('sets HttpOnly cookies and returns user on success', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(TEST_EMAIL);
    expect(res.body.token).toBeUndefined(); // token must NOT be in body

    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();

    const accessCookie  = cookies.find(c => c.startsWith('access_token='));
    const refreshCookie = cookies.find(c => c.startsWith('refresh_token='));

    expect(accessCookie).toBeDefined();
    expect(accessCookie).toMatch(/HttpOnly/i);
    expect(accessCookie).toMatch(/Secure/i);

    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toMatch(/HttpOnly/i);
    expect(refreshCookie).toMatch(/Path=\/api\/auth/i);
  });
});

describe('GET /api/auth/me', () => {
  let accessCookie;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    accessCookie = res.headers['set-cookie'].find(c => c.startsWith('access_token='));
  });

  it('returns 401 with no cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user when valid access cookie present', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', accessCookie);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(TEST_EMAIL);
  });
});

describe('POST /api/auth/refresh', () => {
  let refreshCookie;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    refreshCookie = res.headers['set-cookie'].find(c => c.startsWith('refresh_token='));
  });

  it('returns 401 with no cookie', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('issues new access_token cookie from valid refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();

    const cookies = res.headers['set-cookie'];
    const newAccessCookie = cookies?.find(c => c.startsWith('access_token='));
    expect(newAccessCookie).toBeDefined();
    expect(newAccessCookie).toMatch(/HttpOnly/i);
  });
});

describe('POST /api/auth/logout', () => {
  let refreshCookie;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    refreshCookie = res.headers['set-cookie'].find(c => c.startsWith('refresh_token='));
  });

  it('clears cookies and returns 200', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', refreshCookie);

    expect(res.status).toBe(200);

    const cookies = res.headers['set-cookie'] || [];
    const accessCleared  = cookies.find(c => c.startsWith('access_token=;') || c.includes('access_token=;'));
    const refreshCleared = cookies.find(c => c.startsWith('refresh_token=;') || c.includes('refresh_token=;'));
    expect(accessCleared  || cookies.some(c => c.includes('access_token') && c.includes('Max-Age=0'))).toBeTruthy();
    expect(refreshCleared || cookies.some(c => c.includes('refresh_token') && c.includes('Max-Age=0'))).toBeTruthy();
  });

  it('refresh fails after logout (token deleted from DB)', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Add TEST_EMAIL and TEST_PASSWORD to .env**

In `c:\Users\Rahul\OneDrive\Desktop\Projects\ERDE\ev-dashboard-backend\.env`, add:

```
TEST_EMAIL=<a real user email in your DB>
TEST_PASSWORD=<that user's password>
```

- [ ] **Step 3: Run the tests**

```bash
npm test -- --testPathPattern=tests/auth.test.js --verbose
```

Expected: All tests pass (green). If `Invalid credentials` — check that TEST_EMAIL/TEST_PASSWORD match a real DB user.

- [ ] **Step 4: Commit**

```bash
git add tests/auth.test.js .env
git commit -m "test: integration tests for cookie-based auth endpoints"
```

---

## Task 7: Update Frontend — LoginModal.jsx

**Files:**
- Modify: `c:\Users\Rahul\OneDrive\Desktop\Projects\ERDE\ERDE_TEST-main\src\components\LoginModal.jsx`

Remove all localStorage usage. The login endpoint no longer returns a token in the body.

- [ ] **Step 1: Update handleLogin — remove localStorage, update dispatch**

Replace the entire `handleLogin` function (lines 26–106) with:

```javascript
const handleLogin = async () => {
  if (!email || !password) {
    setError("Both email and password are required.");
    return;
  }

  setLoading(true);
  setError("");

  try {
    const { data } = await axios.post(
      `${API_BASE_URL}/api/auth/login`,
      { email, password },
      {
        headers: { "Content-Type": "application/json" },
        withCredentials: true,
      }
    );

    const { user } = data;

    if (typeof onAuth === "function") {
      try { onAuth({ user }); } catch (e) { console.error(e); }
    }

    try {
      window.dispatchEvent(
        new CustomEvent("auth:login", { detail: { user } })
      );
    } catch (e) {
      console.error(e);
    }

    const target = user.role === "admin" ? "/admin/splash" : "/customer/splash";
    navigate(target, { replace: true, state: { fromLogin: true, ts: Date.now() } });

    setTimeout(() => {
      if (window.location.pathname !== target) {
        window.location.replace(target);
      }
    }, 50);

    onClose?.();
  } catch (err) {
    const message =
      err?.response?.data?.error ||
      err?.response?.data?.message ||
      "Invalid credentials. Please try again.";
    setError(message);
    console.error("Login failed:", err);
  } finally {
    setLoading(false);
  }
};
```

- [ ] **Step 2: Update handleReset — remove localStorage calls**

Replace `handleReset` (lines 112–119) with:

```javascript
const handleReset = () => {
  setEmail("");
  setPassword("");
  setError("");
};
```

- [ ] **Step 3: Remove the JSDoc comment referencing token**

Delete lines 11–16 (the `@typedef` comment block that references `token: string`):

```javascript
// DELETE these lines:
/**
 * @typedef {Object} LoginModalProps
 * @property {() => void} [onClose] - Optional close handler
 * @property {(payload: { token: string, user: any }) => void} [onAuth] - Optional callback to push auth state up
 */
```

- [ ] **Step 4: In App.jsx, update the LoginModal usage to remove the stale onSubmit prop**

In `App.jsx`, find the LoginModal render (in the `/` route):

```jsx
// OLD
<LoginModal setShowLogin={setShowLogin} onSubmit={handleLogin} />
```

Change to:
```jsx
<LoginModal setShowLogin={setShowLogin} />
```

- [ ] **Step 4: Commit**

```bash
cd c:\Users\Rahul\OneDrive\Desktop\Projects\ERDE\ERDE_TEST-main
git add src/components/LoginModal.jsx
git commit -m "feat: remove localStorage token storage from login"
```

---

## Task 8: Update Frontend — App.jsx

**Files:**
- Modify: `c:\Users\Rahul\OneDrive\Desktop\Projects\ERDE\ERDE_TEST-main\src\App.jsx`

This is the largest frontend change. Replace localStorage init with `/api/auth/me`, add the 401 interceptor, update logout.

- [ ] **Step 1: Add API_BASE_URL constant at the top of App.jsx**

After the imports (before `function App()`), add:

```javascript
const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
```

- [ ] **Step 2: Replace the user state initializer**

Replace lines 37–45:
```javascript
// OLD — reads from localStorage
const [user, setUser] = useState(() => {
  const storedUser = localStorage.getItem("user");
  try {
    return storedUser ? JSON.parse(storedUser) : null;
  } catch (err) {
    console.error("Error parsing user from localStorage:", err.message);
    return null;
  }
});
```

With:
```javascript
const [user, setUser] = useState(null);
const [authLoading, setAuthLoading] = useState(true);
```

- [ ] **Step 3: Replace the user useEffect (lines 50–70)**

Replace the existing `useEffect` that sets the Authorization header with:

```javascript
// Set axios withCredentials globally — cookies sent on every request
axios.defaults.withCredentials = true;

// On mount: check if a valid session cookie exists
useEffect(() => {
  axios
    .get(`${API_BASE_URL}/api/auth/me`)
    .then((res) => setUser(res.data.user))
    .catch(() => setUser(null))
    .finally(() => setAuthLoading(false));
}, []);

// Listen for login events dispatched by LoginModal
useEffect(() => {
  const handleAuthLogin = (e) => {
    setUser(e.detail.user);
    setAuthLoading(false);
  };
  window.addEventListener("auth:login", handleAuthLogin);
  return () => window.removeEventListener("auth:login", handleAuthLogin);
}, []);

// Navigate based on user state changes
useEffect(() => {
  if (authLoading) return;

  if (user) {
    setShowLogin(false);
    const isLoginPage =
      location.pathname === "/" || location.pathname === "/login";
    if (isLoginPage) {
      const redirectTo =
        user.role === "admin" ? "/admin/splash" : "/customer/splash";
      navigate(redirectTo, { replace: true });
    }
  } else {
    setShowLogin(true);
    if (location.pathname !== "/") {
      navigate("/", { replace: true });
    }
  }
}, [user, authLoading, location.pathname, navigate]);

// Axios 401 interceptor — silently refresh then retry
useEffect(() => {
  const interceptorId = axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;
      const isAuthEndpoint = originalRequest.url?.includes("/api/auth/");

      if (
        error.response?.status === 401 &&
        !originalRequest._retry &&
        !isAuthEndpoint
      ) {
        originalRequest._retry = true;
        try {
          await axios.post(
            `${API_BASE_URL}/api/auth/refresh`,
            {},
            { withCredentials: true }
          );
          return axios(originalRequest);
        } catch {
          setUser(null);
          navigate("/", { replace: true });
        }
      }

      return Promise.reject(error);
    }
  );

  return () => axios.interceptors.response.eject(interceptorId);
}, [navigate]);
```

- [ ] **Step 4: Replace handleLogin**

Replace the existing `handleLogin` (lines 72–80) — it is currently unused by LoginModal but kept for safety — with a no-op that won't break anything if called:

```javascript
const handleLogin = () => {
  // Auth state is driven by the auth:login event from LoginModal
};
```

- [ ] **Step 5: Replace handleLogout**

Replace lines 82–88:
```javascript
// OLD
const handleLogout = () => {
  setUser(null);
  localStorage.removeItem("user");
  delete axios.defaults.headers.common["Authorization"];
  setShowLogin(true);
  navigate("/", { replace: true });
};
```

With:
```javascript
const handleLogout = async () => {
  try {
    await axios.post(`${API_BASE_URL}/api/auth/logout`, {}, { withCredentials: true });
  } catch (err) {
    console.warn("Logout request failed:", err.message);
  }
  setUser(null);
  setShowLogin(true);
  navigate("/", { replace: true });
};
```

- [ ] **Step 6: Add loading gate to prevent login flash**

In the JSX `return` statement, wrap the entire output with an auth-loading guard. After the opening `<div className="min-h-screen">`, add:

```javascript
return (
  <div className="min-h-screen">
    {authLoading ? (
      <div className="min-h-screen flex items-center justify-center bg-[#0b0f17]">
        <div className="w-10 h-10 border-4 border-orange-500/30 border-t-orange-500 rounded-full animate-spin" />
      </div>
    ) : (
      <Routes>
        {/* ... all existing routes unchanged ... */}
      </Routes>
    )}
  </div>
);
```

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "feat: replace localStorage auth with /me session check and 401 interceptor"
```

---

## Task 9: Update Frontend — Header.jsx

**Files:**
- Modify: `c:\Users\Rahul\OneDrive\Desktop\Projects\ERDE\ERDE_TEST-main\src\components\Header.jsx`

The change-password fetch currently reads the JWT from localStorage. After the redesign, the cookie is sent automatically via `credentials: 'include'`.

- [ ] **Step 1: Update handleChangePassword — remove localStorage token read**

Replace lines 91–105 (the fetch call inside `handleChangePassword`):

```javascript
// OLD
const token = localStorage.getItem("token") || user?.token;
const res = await fetch(`${API_BASE_URL}/api/user/change-password`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    current_password: currentPassword,
    new_password: newPassword,
    confirm_password: confirmPassword,
  }),
});
```

With:
```javascript
const res = await fetch(`${API_BASE_URL}/api/user/change-password`, {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    current_password: currentPassword,
    new_password: newPassword,
    confirm_password: confirmPassword,
  }),
});
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Header.jsx
git commit -m "feat: change-password uses cookie auth instead of localStorage token"
```

---

## Task 10: End-to-End Verification

- [ ] **Step 1: Start the backend**

```bash
cd c:\Users\Rahul\OneDrive\Desktop\Projects\ERDE\ev-dashboard-backend
npm run dev
```

- [ ] **Step 2: Start the frontend**

```bash
cd c:\Users\Rahul\OneDrive\Desktop\Projects\ERDE\ERDE_TEST-main
npm run dev
```

- [ ] **Step 3: Open browser DevTools → Application → Storage**

Verify `localStorage` contains **no** `token`, `user`, or `loginPassword` keys after login.

- [ ] **Step 4: Open DevTools → Application → Cookies**

After login, verify:
- `access_token` cookie exists, is `HttpOnly`, `Secure`, `SameSite=Strict`
- `refresh_token` cookie exists, is `HttpOnly`, `Secure`, `Path=/api/auth`

- [ ] **Step 5: Verify silent refresh**

In DevTools → Application → Cookies, manually delete the `access_token` cookie (keep `refresh_token`). Then trigger any API call (navigate to a page). Verify:
- Network tab shows a call to `/api/auth/refresh` returning 200
- The original request is retried and succeeds
- A new `access_token` cookie appears

- [ ] **Step 6: Verify logout**

Click Logout. Verify:
- Network tab shows `POST /api/auth/logout` returning 200
- Both cookies are cleared
- App redirects to login

- [ ] **Step 7: Verify security headers**

In DevTools → Network → click any response → Headers. Verify presence of:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security: max-age=31536000`
- `Content-Security-Policy`

- [ ] **Step 8: Final backend commit (if any files unstaged)**

```bash
cd c:\Users\Rahul\OneDrive\Desktop\Projects\ERDE\ev-dashboard-backend
git status
git add -p   # stage any remaining changes
git commit -m "feat: auth security redesign complete"
```
