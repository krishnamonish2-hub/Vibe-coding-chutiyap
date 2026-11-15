// Admin reports and the contract §3 training-data export (owner's Phase 7). Admin role only, enforced here. Read-only:
// no retraining is triggered — the CSV is a download for a separate, manual ML process.

import { Router } from 'express';

import { requireAuth, requireRole } from '../../middleware/auth.js';
import { accuracyReport, trainingExport, wasteReport } from '../../services/reports.js';

export function createAdminReportsRouter({ pool, config }) {
  const router = Router();
  router.use(requireAuth({ pool, config }), requireRole('admin'));

  router.get('/reports/accuracy', async (req, res) => {
    res.json(await accuracyReport(pool));
  });

  router.get('/reports/waste', async (req, res) => {
    res.json(await wasteReport(pool));
  });

  router.get('/export/training.csv', async (req, res) => {
    const { runId, csv } = await trainingExport(pool);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="messmind-training-export-run${runId}.csv"`);
    res.set('Cache-Control', 'no-store');
    res.send(csv);
  });

  return router;
}
