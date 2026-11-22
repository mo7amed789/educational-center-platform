import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { requireUser } from './auth.js';
import { z } from 'zod';

const stateSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(['starting','waiting','checking','up_to_date','backing_up','installing','applying_schema','restarting','updated','blocked','rolling_back','rolled_back','manual_recovery','disabled']),
  currentCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(), availableCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  checkedAt: z.string().datetime().optional(), updatedAt: z.string().datetime().optional(), nextCheckAt: z.string().datetime().nullable().optional(),
  failureStage: z.enum(['checking','backup','checkout','install','schema','build','restart']).optional(),
});
export function registerAutoUpdateRoutes(app: FastifyInstance) {
  app.get('/api/center/system/update-status', async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (user.role !== 'CENTER_OWNER' || !user.centerId) return reply.code(403).send({ error: 'FORBIDDEN' });
    if (!process.env.EDU_MANAGED_STATE) return { enabled: false, state: 'disabled', managed: false };
    try {
      const data = stateSchema.parse(JSON.parse(await readFile(process.env.EDU_MANAGED_STATE, 'utf8')));
      return { ...data, managed: true };
    } catch { return reply.code(503).send({ error: 'UPDATE_STATUS_UNAVAILABLE' }); }
  });
}
