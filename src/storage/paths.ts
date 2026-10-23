import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { ArtifactRecord } from '../core/contracts';

export function contained(root: string, ...segments: string[]) {
  const absolute = path.resolve(root),
    file = path.resolve(absolute, ...segments);
  if (!isWithin(absolute, file)) throw new Error('Evidence path escapes its managed directory.');
  return file;
}
export function isWithin(root: string, file: string) {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}
export function evidencePath(artifact: ArtifactRecord, artifactDir: string, archiveDir?: string) {
  if (artifact.storage === 'expired')
    throw new Error('Evidence expired under the configured retention policy.');
  let root = artifactDir;
  if (artifact.storage === 'archived') {
    if (!archiveDir || !artifact.archiveId || !/^[a-f0-9-]{36}$/.test(artifact.archiveId))
      throw new Error('Evidence archive is unavailable.');
    root = contained(archiveDir, artifact.archiveId, 'artifacts');
  }
  const file = contained(root, artifact.filename);
  const realRoot = realpathSync(root),
    realFile = realpathSync(file);
  const realBoundary = realpathSync(artifact.storage === 'archived' ? archiveDir! : artifactDir);
  if (!isWithin(realRoot, realFile) || !isWithin(realBoundary, realFile))
    throw new Error('Evidence symlink escapes its managed directory.');
  return realFile;
}
