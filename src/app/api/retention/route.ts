import { z } from 'zod';
import { getStore, localRequest, forbidden } from '@/server/service';
import { previewRetention } from '@/storage/retention';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  if (!localRequest(req)) return forbidden();
  const store = getStore();
  store.reapRetentionJobs();
  const job = new URL(req.url).searchParams.get('job');
  if (job) {
    const result = store.retentionJob(job);
    return result
      ? Response.json(result)
      : Response.json({ error: 'Maintenance job not found' }, { status: 404 });
  }
  const stats = store.sqlite
    .prepare(
      "SELECT COUNT(*) as archives,COALESCE(SUM(CASE WHEN state='ready' THEN bytes ELSE 0 END),0) as archivedBytes,COALESCE(SUM(CASE WHEN state='purged' THEN 1 ELSE 0 END),0) as expiredArchives FROM evidence_archives",
    )
    .get();
  try {
    const latest = store.sqlite
      .prepare('SELECT id FROM retention_jobs ORDER BY createdAt DESC LIMIT 1')
      .get() as { id: string } | undefined;
    return Response.json({
      ...(await previewRetention(store)),
      stats,
      latestJob: latest ? store.retentionJob(latest.id) : null,
    });
  } catch {
    return Response.json(
      {
        error:
          'Evidence storage configuration is invalid. Working and archive directories must be separate.',
      },
      { status: 400 },
    );
  }
}
export async function POST(req: Request) {
  if (!localRequest(req, true)) return forbidden();
  const parsed = z
    .strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/) })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: 'A reviewed retention preview token is required.' },
      { status: 400 },
    );
  const store = getStore(),
    preview = await previewRetention(store);
  if (!preview.policy.enabled)
    return Response.json(
      { error: 'Retention is disabled. Configure RETENTION_DAYS first.' },
      { status: 409 },
    );
  if (parsed.data.token !== preview.token)
    return Response.json(
      { error: 'Preview changed. Refresh and review before applying.' },
      { status: 409 },
    );
  return Response.json({ id: store.enqueueRetention(preview.token) }, { status: 202 });
}
