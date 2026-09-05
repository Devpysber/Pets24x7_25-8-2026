// Legacy SSR admin panel mounted at /admin.
// Redirects all legacy routes to the official SPA Admin Portal at /dashboard/admin/.

import { Router } from 'express';
import { env } from '../env.js';

export const adminPanelRouter = Router();

adminPanelRouter.all('*', (_req, res) => {
  const siteUrl = env.NODE_ENV === 'development' ? 'http://localhost:8000' : (env.PUBLIC_SITE_URL || 'http://localhost:8000');
  res.redirect(301, `${siteUrl}/dashboard/admin/`);
});

