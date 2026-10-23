import { getStore, localRequest, forbidden } from '@/server/service';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!localRequest(req)) return forbidden();
  const store = getStore();
  store.reap();
  const detail = store.detail((await params).id);
  return detail
    ? Response.json(detail)
    : Response.json({ error: 'Run not found' }, { status: 404 });
}
