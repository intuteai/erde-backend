# Auth & Security Redesign — Design Spec
**Date:** 2026-06-09  
**Project:** ERDE EV Dashboard (Backend + Frontend)  
**Status:** Approved

---

## Goal

Replace the current localStorage-based JWT system with a production-grade HttpOnly cookie auth system featuring silent token refresh, multi-device session tracking, and security headers.

---

## Constraints & Decisions

| Decision | Choice | Reason |
|---|---|---|
| Deployment | HTTPS (analytics.erdeenergy.in) | Enables HttpOnly Secure cookies |
| Session model | Silent refresh (15min access + 7-day refresh) | Best UX, user stays logged in without noticing |
| Multi-device | Yes — per-device refresh token rows | Enables "logout all devices" in future |
| Account lockout | No — keep existing rate limiter only | Sufficient for current threat model |
| 2FA | No | Out of scope |

---

## Architecture Overview

### What Changes

- Login response sets two **HttpOnly Secure SameSite=Strict** cookies instead of returning a token in JSON
- New `/api/auth/refresh` endpoint issues a new access token using the refresh cookie
- New `/api/auth/logout` endpoint clears cookies and deletes the DB session row
- New `GET /api/auth/me` endpoint rehydrates frontend state on page load
- `middleware/auth.js` reads JWT from cookie (primary) with Authorization header fallback
- Frontend removes all `localStorage` token/password usage; Axios uses `withCredentials: true`
- Axios 401 interceptor silently calls `/refresh` and retries, redirecting to login only if refresh fails

### What Stays the Same

- bcrypt password hashing (12 rounds)
- JWT payload structure (`user_id`, `email`, `role`, `name`, `customer_id`)
- RBAC middleware (`checkPermission.js`) — reads `req.user`, unchanged
- Rate limiting (all 3 configs)
- Telemetry API key auth
- WebSocket token-in-query-param (cookies don't work for WS handshakes)

---

## Database Schema

### New Table: `refresh_tokens`

```sql
CREATE TABLE refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  device_info   TEXT,
  ip_address    INET,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_used_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
```

**Notes:**
- `token_hash` = SHA-256 of the raw token — raw value never stored
- `ON DELETE CASCADE` — user deletion auto-cleans all sessions
- `expires_at` index supports efficient nightly cleanup job
- `device_info` + `ip_address` enable future "active sessions" UI

---

## Backend Changes

### `routes/auth.js` — Login

1. After bcrypt verify succeeds:
   - Generate access token: `jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' })`
   - Generate refresh token: `crypto.randomBytes(64).toString('hex')`
2. Store `SHA256(refreshToken)`, `user_id`, `device_info` (user-agent), `ip_address`, `expires_at` (now + 7 days) in `refresh_tokens`
3. Set cookies:
   ```
   access_token:  HttpOnly, Secure, SameSite=Strict, Path=/,         MaxAge=900
   refresh_token: HttpOnly, Secure, SameSite=Strict, Path=/api/auth, MaxAge=604800
   ```
4. Return JSON body: `{ user: { name, email, role, customer_id } }` — no token in body

### New `POST /api/auth/refresh`

1. Read `refresh_token` cookie
2. SHA-256 hash it, query `refresh_tokens` WHERE `token_hash = $1 AND expires_at > now()`
3. If not found → 401
4. Issue new access token JWT (15min), set new `access_token` cookie
5. Update `last_used_at` on the row — **no token rotation** (same refresh token reused for its 7-day lifetime; rotation can be added later if needed)
6. Return `{ user: { name, email, role, customer_id } }`

### New `POST /api/auth/logout`

1. Read `refresh_token` cookie, SHA-256 hash it
2. DELETE from `refresh_tokens` WHERE `token_hash = $1`
3. Clear both cookies: `res.clearCookie('access_token')`, `res.clearCookie('refresh_token', { path: '/api/auth' })`
4. Return 200

### New `GET /api/auth/me`

- Protected by `authenticateToken` middleware
- Returns `{ user: req.user }` — used by frontend to rehydrate state on page load

### `middleware/auth.js`

Token source priority:
1. `req.cookies.access_token` (primary)
2. `Authorization: Bearer <token>` header (fallback for non-browser clients)
3. `?token=` query param (SSE/WebSocket, unchanged)

Requires `cookie-parser` added to `app.js`.

### `app.js`

```js
const cookieParser = require('cookie-parser');
const helmet = require('helmet');

app.use(cookieParser());
app.use(helmet({ /* see Security Headers section */ }));

// CORS — add credentials: true
cors({
  origin: [...existing origins],
  credentials: true,   // ← new
})
```

---

## Frontend Changes

### `src/components/LoginModal.jsx`

- Remove: `localStorage.setItem('token', token)`
- Remove: `localStorage.setItem('user', JSON.stringify(authPayload))`
- Remove: `localStorage.setItem('loginPassword', password)` ← plaintext password leak fixed
- On success: dispatch `auth:login` event with `{ user: { name, email, role, customer_id } }` only (no token)

### `src/App.jsx`

- Remove: `localStorage.getItem('token')` init
- Remove: `axios.defaults.headers.common['Authorization']` setup
- Add: `axios.defaults.withCredentials = true`
- On app mount: call `GET /api/auth/me` to rehydrate user state (replaces localStorage read)
- Logout: call `POST /api/auth/logout`, then clear React user state

### Axios 401 Interceptor (in `App.jsx` or `src/lib/axios.js`)

```
response interceptor:
  on 401:
    if not already retrying:
      call POST /api/auth/refresh
      if refresh succeeds: retry original request
      if refresh fails: clear user state, redirect to /login
```

### `src/components/Header.jsx`

- Remove `localStorage.getItem('token')` from change-password call — `withCredentials` sends cookie automatically

---

## Security Headers (`helmet` config in `app.js`)

```js
helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      connectSrc: ["'self'", "https://analytics.erdeenergy.in"],
      imgSrc:     ["'self'", "data:"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
    }
  },
  hsts:       { maxAge: 31536000, includeSubDomains: true },
  frameguard: { action: 'deny' },
  noSniff:    true,
})
```

| Header | Protection |
|---|---|
| Content-Security-Policy | Blocks injected scripts (XSS mitigation) |
| Strict-Transport-Security | Browser refuses HTTP for 1 year |
| X-Frame-Options: DENY | Blocks clickjacking via iframe |
| X-Content-Type-Options: nosniff | Blocks MIME confusion attacks |

---

## New Dependencies

| Package | Where | Purpose |
|---|---|---|
| `cookie-parser` | Backend | Parse cookies in Express |
| `helmet` | Backend | Security headers |

Frontend: no new dependencies. `axios` already installed.

---

## Files Changed

### Backend
- `routes/auth.js` — login rewrite + refresh + logout + me endpoints
- `middleware/auth.js` — cookie-first token reading
- `app.js` — cookie-parser, helmet, CORS credentials
- `db/migrations/001_refresh_tokens.sql` — new table (new file)

### Frontend
- `src/App.jsx` — withCredentials, /me call, interceptor, logout
- `src/components/LoginModal.jsx` — remove all localStorage
- `src/components/Header.jsx` — remove localStorage token read

---

## What This Fixes

| Issue | Before | After |
|---|---|---|
| XSS token theft | JWT in localStorage — stealable | HttpOnly cookie — JS cannot read |
| Plaintext password leak | Stored in localStorage | Removed entirely |
| Session invalidation | Impossible (stateless JWT) | DELETE row from refresh_tokens |
| Multi-device | Not tracked | Per-device rows, revocable |
| Token lifetime | 24h with no revocation | 15min access + 7-day silent refresh |
| Clickjacking | No protection | X-Frame-Options: DENY |
| HTTPS enforcement | None server-side | HSTS 1 year |
