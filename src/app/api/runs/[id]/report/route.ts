import { getStore, localRequest, forbidden } from '@/server/service';
import { markdownReport, htmlReport } from '@/reports/report';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!localRequest(req)) return forbidden();
  const store = getStore(),
    detail = store.detail((await params).id);
  if (!detail) return Response.json({ error: 'Run not found' }, { status: 404 });
  const html = new URL(req.url).searchParams.get('format') === 'html';
  return new Response(
    html
      ? htmlReport(detail, store.config.artifactDir, store.config.archiveDir)
      : markdownReport(detail),
    {
      headers: {
        'Content-Type': html ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="proofpack-${detail.run.id.slice(0, 8)}.${html ? 'html' : 'md'}"`,
        'Cache-Control': 'no-store',
      },
    },
  );
}
