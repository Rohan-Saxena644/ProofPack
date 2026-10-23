import { readFile } from 'node:fs/promises';
import { evidencePath } from '@/storage/paths';
import type { ArtifactRecord } from '@/core/contracts';
import { getStore, localRequest, forbidden } from '@/server/service';
export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!localRequest(req)) return forbidden();
  const store = getStore();
  const raw = store.sqlite.prepare('SELECT * FROM artifacts WHERE id=?').get((await params).id) as
    ArtifactRecord | undefined;
  const artifact = raw ? store.decorateArtifacts([raw])[0] : undefined;
  if (!artifact) return Response.json({ error: 'Evidence not found' }, { status: 404 });
  if (artifact.storage === 'expired')
    return Response.json(
      {
        error:
          'Evidence expired under the configured retention policy. Assertion history is retained.',
      },
      { status: 410 },
    );
  try {
    const data = await readFile(
      evidencePath(artifact, store.config.artifactDir, store.config.archiveDir),
    );
    return new Response(data, {
      headers: {
        'Content-Type': artifact.kind === 'trace' ? 'application/zip' : 'image/png',
        'Content-Disposition': `${artifact.kind === 'trace' ? 'attachment' : 'inline'}; filename="${artifact.id}.${artifact.kind === 'trace' ? 'zip' : 'png'}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return Response.json({ error: 'Evidence file is unavailable' }, { status: 404 });
  }
}
