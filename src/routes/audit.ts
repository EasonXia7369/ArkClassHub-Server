import { Hono } from 'hono'
import type { AppContext } from '../types.js'
import { authenticate, readGuard, requireRole } from '../auth.js'

export const auditRoutes = new Hono<AppContext>()

auditRoutes.get(
  '/api/classes/:id/audit',
  authenticate,
  requireRole('teacher', 'admin', 'student'),
  readGuard,
  async (c) => {
    const classId = Number(c.req.param('id'))
    const limit = Math.min(Number(c.req.query('limit') ?? 200), 500)
    const logs = (
      await c.env.DB.prepare(
        `SELECT ts, actor, action, detail FROM audit_logs
         WHERE class_id = ?1 ORDER BY id DESC LIMIT ?2`,
      )
        .bind(classId, limit)
        .all<any>()
    ).results
    return c.json({ logs })
  },
)
