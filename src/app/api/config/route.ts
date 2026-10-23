import { publicConfig } from '@/core/config';
import { getStore, localRequest, forbidden } from '@/server/service';
export const dynamic = 'force-dynamic';
export function GET(req: Request) { if (!localRequest(req)) return forbidden(); const store = getStore(); store.reap(); return Response.json(publicConfig(store.config)); }
