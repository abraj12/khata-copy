import { Router, Request, Response } from 'express';
import { requireOwnerSession } from '../../middleware/requireOwnerSession.js';
import { env } from '../../config/env.js';

export interface RealtimeStatus {
  enabled: boolean;
  status: 'deferred' | 'active';
  authoritativeSource: 'REST_API';
  realtimeEndpoint: string | null;
  notes: string;
}

export class RealtimeManager {
  public getStatus(): RealtimeStatus {
    return {
      enabled: false,
      status: 'deferred',
      authoritativeSource: 'REST_API',
      realtimeEndpoint: env.NEON_REALTIME_URL || null,
      notes:
        'Neon Realtime integration is deferred pending general availability. Authenticated REST endpoints provide the authoritative, atomic source of truth.',
    };
  }
}

export const realtimeManager = new RealtimeManager();

const router = Router();
router.use(requireOwnerSession);

router.get('/status', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: realtimeManager.getStatus(),
  });
});

export const realtimeRoutes = router;
