import { Hono } from 'hono';
import { csrfGuard } from '../../auth.js';
import { accountRoutes } from './accounts.js';
import { aliasRoutes } from './aliases.js';
import { authRoutes } from './auth.js';
import { clientKeyRoutes } from './clientKeys.js';
import { comboRoutes } from './combos.js';
import { requireAdminJson } from './middleware.js';
import { modelRoutes } from './models.js';
import { overviewRoutes } from './overview.js';
import { quotaRoutes } from './quota.js';
import { requestLogRoutes } from './requestLogs.js';
import { settingsRoutes } from './settings.js';
import { transportRoutes } from './transports.js';
import { usageRoutes } from './usage.js';

export function adminApi(): Hono {
  const app = new Hono();
  app.use('/admin/*', requireAdminJson);
  app.use('*', csrfGuard);
  app.route('/', authRoutes);
  app.route('/admin', overviewRoutes);
  app.route('/admin', usageRoutes);
  app.route('/admin', requestLogRoutes);
  app.route('/admin/client-keys', clientKeyRoutes);
  app.route('/admin/accounts', accountRoutes);
  app.route('/admin/models', modelRoutes);
  app.route('/admin/aliases', aliasRoutes);
  app.route('/admin/combos', comboRoutes);
  app.route('/admin', quotaRoutes);
  app.route('/admin/settings', settingsRoutes);
  app.route('/admin/transports', transportRoutes);
  return app;
}
