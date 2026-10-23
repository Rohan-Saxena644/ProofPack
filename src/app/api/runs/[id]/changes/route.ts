import { getStore, localRequest, forbidden } from '@/server/service';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!localRequest(req)) return forbidden();
  const raw = new URL(req.url).searchParams.get('after');
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    return Response.json({ error: 'A valid nonnegative cursor is required.' }, { status: 400 });
  const store = getStore();
  store.reap();
  const delta = store.changes((await params).id, Number(raw));
  return delta
    ? Response.json(delta, { headers: { 'Cache-Control': 'no-store' } })
    : Response.json({ error: 'Run not found' }, { status: 404 });
}
