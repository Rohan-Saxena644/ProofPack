import { getStore, localRequest, forbidden } from '@/server/service';
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  if (!localRequest(req, true)) return forbidden();
  const { id, action } = await params,
    store = getStore();
  if (!store.get(id)) return Response.json({ error: 'Run not found' }, { status: 404 });
  if (action === 'cancel') {
    store.cancel(id);
    return Response.json({ ok: true });
  }
  if (action === 'retry')
    return store.retry(id)
      ? Response.json({ ok: true })
      : Response.json(
          {
            error: store.retryPolicy(id).reason,
            retry: store.retryPolicy(id),
          },
          { status: 409 },
        );
  return Response.json({ error: 'Action not found' }, { status: 404 });
}
