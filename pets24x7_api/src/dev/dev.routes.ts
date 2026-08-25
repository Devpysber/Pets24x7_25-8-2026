import { Router } from 'express';
import { setAuthCookie, clearAuthCookie } from '../auth/jwt.js';
import { env } from '../env.js';

export const devRouter = Router();

// Dedicated Dev Login Routes
devRouter.get('/login/admin', (_req, res) => {
  setAuthCookie(res, { sub: 'dev-admin-id', role: 'admin' });
  res.redirect('/admin/dashboard');
});

devRouter.get('/login/parent', (_req, res) => {
  setAuthCookie(res, { sub: 'dev-parent-id', role: 'pet_parent' });
  const siteUrl = env.NODE_ENV === 'development' ? 'http://localhost:8000' : env.PUBLIC_SITE_URL;
  res.redirect(`${siteUrl}/dashboard/parent/`);
});

devRouter.get('/login/vendor', (_req, res) => {
  setAuthCookie(res, { sub: 'dev-vendor-id', role: 'vendor' });
  const siteUrl = env.NODE_ENV === 'development' ? 'http://localhost:8000' : env.PUBLIC_SITE_URL;
  res.redirect(`${siteUrl}/dashboard/vendor/`);
});

devRouter.get('/logout-all', (_req, res) => {
  clearAuthCookie(res, 'admin');
  clearAuthCookie(res, 'pet_parent');
  clearAuthCookie(res, 'vendor');
  res.redirect('/dev');
});

// Dev Portal UI
devRouter.get('/', (_req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pets24x7 — Dev Access Portal</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0F172A; color: #F8FAFC; padding: 40px 20px; line-height: 1.5; }
    .container { max-width: 900px; margin: 0 auto; }
    .badge { display: inline-block; background: #3B82F6; color: white; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 99px; margin-bottom: 12px; }
    h1 { font-size: 32px; font-weight: 800; margin-bottom: 8px; }
    p.sub { color: #94A3B8; font-size: 16px; margin-bottom: 32px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; margin-bottom: 32px; }
    .card { background: #1E293B; border: 1px solid #334155; border-radius: 12px; padding: 24px; display: flex; flex-direction: column; justify-content: space-between; }
    .card h2 { font-size: 20px; font-weight: 700; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
    .card p { color: #94A3B8; font-size: 14px; margin-bottom: 20px; flex-grow: 1; }
    .btn { display: inline-block; text-align: center; background: #2563EB; color: white; font-weight: 600; font-size: 14px; text-decoration: none; padding: 12px 16px; border-radius: 8px; transition: background 0.2s; }
    .btn:hover { background: #1D4ED8; }
    .btn-green { background: #059669; } .btn-green:hover { background: #047857; }
    .btn-purple { background: #7C3AED; } .btn-purple:hover { background: #6D28D9; }
    .creds { background: #1E293B; border: 1px solid #334155; border-radius: 12px; padding: 24px; }
    .creds h3 { font-size: 18px; font-weight: 700; margin-bottom: 16px; color: #F1F5F9; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
    th { color: #94A3B8; padding: 8px 12px; border-bottom: 1px solid #334155; }
    td { padding: 12px; border-bottom: 1px solid #334155; }
    code { background: #0F172A; color: #38BDF8; font-family: monospace; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <span class="badge">DEVELOPMENT MODE</span>
    <h1>Pets24x7 Dev Access Portal</h1>
    <p class="sub">One-click temporary authentication to access all dashboards during development.</p>

    <div class="grid">
      <div class="card">
        <div>
          <h2>🛡️ Admin Panel</h2>
          <p>Access the EJS admin panel to manage vendors, pet parents, enquiries, memberships, and payments.</p>
        </div>
        <a href="/api/dev/login/admin" class="btn btn-purple">Launch Admin Panel</a>
      </div>

      <div class="card">
        <div>
          <h2>🐶 Pet Parent Dashboard</h2>
          <p>Access the logged-in Pet Parent dashboard to manage pets, view enquiries, and check active memberships.</p>
        </div>
        <a href="/api/dev/login/parent" class="btn">Launch Parent Dashboard</a>
      </div>

      <div class="card">
        <div>
          <h2>🏪 Vendor Dashboard</h2>
          <p>Access the logged-in Vendor dashboard to view listing claims, completion checklist, and reviews.</p>
        </div>
        <a href="/api/dev/login/vendor" class="btn btn-green">Launch Vendor Dashboard</a>
      </div>
    </div>

    <div class="creds">
      <h3>🔑 Quick Reference & Temporary Credentials</h3>
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Login URL / Mechanism</th>
            <th>Dev Credentials / Bypass</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Admin</strong></td>
            <td><code>http://localhost:4000/admin/login</code></td>
            <td>Email: <code>founder@pets24x7.com</code><br>Password: <code>change-me-strong-password</code> (or any pass in dev mode)</td>
          </tr>
          <tr>
            <td><strong>Pet Parent</strong></td>
            <td><code>http://localhost:8000/parent-login/</code></td>
            <td>Phone: Any phone (e.g. <code>+91 9876543210</code>)<br>Universal Dev OTP: <code>123456</code></td>
          </tr>
          <tr>
            <td><strong>Vendor</strong></td>
            <td><code>http://localhost:8000/vendor-login/</code></td>
            <td>Phone: <code>+91 9930090487</code> (or any claimed listing phone)<br>Universal Dev OTP: <code>123456</code></td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top: 16px; font-size: 13px; color: #94A3B8;">
        Need to clear active sessions? <a href="/api/dev/logout-all" style="color: #F43F5E; text-decoration: none;">Clear all cookies</a>
      </div>
    </div>
  </div>
</body>
</html>
  `;
  res.send(html);
});
