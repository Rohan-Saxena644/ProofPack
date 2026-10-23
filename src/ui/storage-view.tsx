'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Archive, ArrowLeft, LoaderCircle, RefreshCw } from 'lucide-react';
import { Shell, getJson } from './shared';
import type { previewRetention } from '@/storage/retention';
type Preview = Awaited<ReturnType<typeof previewRetention>> & {
  stats: { archives: number; archivedBytes: number; expiredArchives: number };
  latestJob: Job | null;
};
type Job = {
  id: string;
  status: string;
  error: string | null;
  result: {
    archived: unknown[];
    purged: unknown[];
    errors: { id: string; error: string }[];
  } | null;
};
const size = (bytes: number) =>
  bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
export function StorageView() {
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [jobId, setJobId] = useState(''),
    [job, setJob] = useState<Job | null>(null),
    [busy, setBusy] = useState(false),
    [expiryReviewed, setExpiryReviewed] = useState(false);
  const accept = useCallback((next: Preview) => {
    setPreview(next);
    setExpiryReviewed(false);
    setError('');
    if (next.latestJob) {
      setJob(next.latestJob);
      if (['queued', 'running'].includes(next.latestJob.status)) {
        setBusy(true);
        setJobId(next.latestJob.id);
      }
    }
  }, []);
  const refresh = useCallback(async () => {
    try {
      accept(await getJson<Preview>('/api/retention'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [accept]);
  useEffect(() => {
    let active = true;
    void getJson<Preview>('/api/retention')
      .then((next) => {
        if (active) accept(next);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [accept]);
  useEffect(() => {
    if (!jobId) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getJson<Job>(`/api/retention?job=${jobId}`);
        if (!active) return;
        setJob(next);
        if (['queued', 'running'].includes(next.status)) timer = setTimeout(poll, 1500);
        else {
          setBusy(false);
          void refresh();
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
          setBusy(false);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [jobId, refresh]);
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const response = await getJson<{ id: string }>('/api/retention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: preview.token }),
      });
      setJobId(response.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Shell>
      <Link href="/" className="back-link">
        <ArrowLeft size={16} />
        Back to workspace
      </Link>
      <div className="detail-heading">
        <div>
          <div className="eyebrow">KEEP THE PROOF. CONTROL THE FOOTPRINT.</div>
          <h1>Evidence storage</h1>
          <p>Review what moves to the archive and what stays available.</p>
        </div>
        <Archive size={28} />
      </div>
      {error && (
        <div role="alert" className="error-box">
          {error}
        </div>
      )}
      {!preview ? (
        <div className="empty-state">
          <LoaderCircle className="spin" />
          Loading storage policy…
        </div>
      ) : (
        <>
          <div className="stats-row storage-stats">
            <div>
              <span>ARCHIVE AFTER</span>
              <strong>
                {preview.policy.enabled ? `${preview.policy.archiveAfterDays} days` : 'Off'}
              </strong>
            </div>
            <div>
              <span>PROTECTED RECENT RUNS</span>
              <strong>{preview.policy.keepNewestRuns}</strong>
            </div>
            <div>
              <span>ARCHIVE EXPIRY</span>
              <strong>
                {preview.policy.expireArchiveAfterDays
                  ? `${preview.policy.expireArchiveAfterDays} days`
                  : 'Off'}
              </strong>
            </div>
            <div>
              <span>ARCHIVED EVIDENCE</span>
              <strong>{size(preview.stats.archivedBytes)}</strong>
            </div>
          </div>
          <section className="panel report-request">
            <h2>Your retention policy</h2>
            <p>
              Archival copies evidence and its run snapshot, verifies checksums, then removes the
              verified working copies. Archived screenshots and traces remain available through
              reports and downloads. Assertion history stays in the database.
            </p>
            {!preview.policy.enabled && (
              <div className="info-banner">
                Retention is off. Set RETENTION_DAYS in server configuration to choose an archival
                age. Archive expiry stays off unless ARCHIVE_RETENTION_DAYS is also set.
              </div>
            )}
            <p className="muted small">
              Each maintenance job handles up to {preview.policy.batchSize} runs and{' '}
              {preview.policy.batchSize} archives. A separate worker performs the file operations.
            </p>
          </section>
          <section className="panel assertion-panel">
            <div className="panel-heading">
              <h2>Ready to archive</h2>
              <span className="muted small">
                {preview.archive.length} runs · {size(preview.archiveBytes)}
              </span>
            </div>
            {preview.archive.length ? (
              <div className="table-scroll">
                <table className="assertion-table">
                  <thead>
                    <tr>
                      <th>RUN</th>
                      <th>OUTCOME</th>
                      <th>EVIDENCE</th>
                      <th>SIZE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.archive.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <Link href={`/runs/${run.id}`}>{run.brief.slice(0, 90)}</Link>
                          <small>{run.id.slice(0, 8)}</small>
                        </td>
                        <td>{run.status}</td>
                        <td>
                          {run.artifactCount} files
                          {run.missingFiles > 0 && (
                            <small className="step-error">
                              {run.missingFiles} missing; archival will preserve originals and
                              report an error
                            </small>
                          )}
                        </td>
                        <td>{size(run.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="panel-empty">
                No runs are eligible. Recent and active runs stay protected.
              </div>
            )}
          </section>
          {preview.purge.length > 0 && (
            <section className="panel report-request">
              <h2>Archives ready to expire</h2>
              <p>
                {preview.purge.length} archives · {size(preview.purgeBytes)}. Expiry permanently
                removes these archived files. Run history and assertions remain.
              </p>
              <ul>
                {preview.purge.map((ar) => (
                  <li key={ar.id}>
                    Run {ar.runId.slice(0, 8)} · archived{' '}
                    {new Date(ar.createdAt).toLocaleDateString()} · {size(ar.bytes)}
                  </li>
                ))}
              </ul>
              <label>
                <input
                  type="checkbox"
                  checked={expiryReviewed}
                  onChange={(event) => setExpiryReviewed(event.target.checked)}
                />{' '}
                I reviewed the archives selected for expiry.
              </label>
            </section>
          )}
          <div className="detail-toolbar">
            <button className="secondary-button" disabled={busy} onClick={() => void refresh()}>
              <RefreshCw size={16} />
              Refresh preview
            </button>
            <button
              className="primary-button"
              disabled={
                busy ||
                !preview.policy.enabled ||
                !(preview.archive.length + preview.purge.length) ||
                (preview.purge.length > 0 && !expiryReviewed)
              }
              onClick={() => void apply()}
            >
              {busy ? <LoaderCircle className="spin" size={16} /> : <Archive size={16} />}{' '}
              {busy
                ? 'Maintenance queued or running…'
                : preview.purge.length
                  ? 'Archive and expire reviewed evidence'
                  : 'Archive eligible evidence'}
            </button>
          </div>
        </>
      )}
      {job && (
        <section className="panel report-request" role="status">
          <h2>Maintenance {job.status}</h2>
          <p>
            {job.status === 'queued'
              ? 'Waiting for a worker.'
              : job.status === 'running'
                ? 'Copying and verifying evidence in the background.'
                : (job.error ?? 'Maintenance finished. Review the result below.')}
          </p>
          {job.result && (
            <>
              <p>
                {job.result.archived.length} runs archived · {job.result.purged.length} archives
                expired
              </p>
              {job.result.errors.map((item) => (
                <p className="step-error" key={item.id}>
                  {item.error}
                </p>
              ))}
            </>
          )}
        </section>
      )}
    </Shell>
  );
}
