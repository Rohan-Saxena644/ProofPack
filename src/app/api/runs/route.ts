import { getStore, localRequest, forbidden } from '@/server/service';
import { runInputSchema } from '@/core/contracts';
import { requireAllowed } from '@/execution/boundaries';
export const dynamic = 'force-dynamic';
export function GET(req: Request) { if (!localRequest(req)) return forbidden(); const s = getStore(); s.reap(); return Response.json(s.list()); }
export async function POST(req: Request) {
  if (!localRequest(req, true)) return forbidden();
  try { const input = runInputSchema.parse(await req.json()); const store = getStore(); requireAllowed(input.targetUrl, store.config.origins); return Response.json(store.create(input), { status: 201 }); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Invalid request' }, { status: 400 }); }
}
