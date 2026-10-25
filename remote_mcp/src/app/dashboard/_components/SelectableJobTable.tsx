"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  GPT_FIT_LABEL,
  GPT_FIT_TOOLTIP,
  PYTHON_RANK_LABEL,
  PYTHON_RANK_TOOLTIP,
  formatGptFit,
  formatPythonRank,
  gptFitTitle,
} from "@/lib/dashboard/scores";

import { DATES, NUMERIC, sortJobs, type Dir, type SortKey } from "@/lib/dashboard/job_sort";

import { IgnoreButton, MarkAppliedButton } from "./Actions";
import { JobBadges, formatDate } from "./job_format";

type Job = Record<string, unknown>;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}

function jobId(job: Job): string {
  return String(job.posting_id || job.id);
}

export function SelectableJobTable({
  jobs,
  showActions = false,
  toolbar,
}: {
  jobs: Job[];
  showActions?: boolean;
  /** Search/filter form rendered on the same bar as the selection actions. */
  toolbar?: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [dir, setDir] = useState<Dir>("asc");
  const [flash, setFlash] = useState<string | null>(null);

  const rows = useMemo(() => sortJobs(jobs, sortKey, dir), [jobs, sortKey, dir]);
  const allIds = rows.map(jobId);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const chosen = rows.filter((j) => selected.has(jobId(j)));
  const chosenWithUrl = chosen.filter((j) => j.url);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds));
  }
  function onSort(key: SortKey) {
    if (sortKey === key) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      // numbers and dates read best highest/newest first
      setDir(NUMERIC.includes(key) || DATES.includes(key) ? "desc" : "asc");
    }
  }
  async function copy(kind: "links" | "list") {
    const text =
      kind === "links"
        ? chosenWithUrl.map((j) => String(j.url)).join("\n")
        : chosenWithUrl
            .map((j) => `${String(j.company || "")} — ${String(j.title || "")}\n${String(j.url)}`)
            .join("\n\n");
    const ok = await copyText(text);
    setFlash(ok ? `Copied ${chosenWithUrl.length} link${chosenWithUrl.length === 1 ? "" : "s"}` : "Copy failed");
    setTimeout(() => setFlash(null), 2500);
  }

  function Th({ k, children, title }: { k: SortKey; children: React.ReactNode; title?: string }) {
    const active = sortKey === k;
    return (
      <th
        className={`sortable${active ? " sorted" : ""}`}
        title={title}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <button type="button" className="th-sort" onClick={() => onSort(k)}>
          {children}
          <span className="sort-arrow" aria-hidden>
            {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
          </span>
        </button>
      </th>
    );
  }

  if (!jobs.length) {
    return (
      <>
        {toolbar ? <div className="table-toolbar"><div className="table-toolbar-search">{toolbar}</div></div> : null}
        <div className="empty">No jobs match this view.</div>
      </>
    );
  }

  return (
    <>
      <div className={`table-toolbar${selected.size ? " active" : ""}`}>
        {toolbar ? <div className="table-toolbar-search">{toolbar}</div> : null}
        <div className="selection-actions">
        <span className="muted">
          {selected.size ? `${selected.size} selected` : `${rows.length} jobs — tick rows to select`}
        </span>
        <button type="button" className="btn btn-ghost" onClick={toggleAll}>
          {allSelected ? "Clear selection" : "Select all"}
        </button>
        <button type="button" className="btn" disabled={!chosenWithUrl.length} onClick={() => copy("links")}>
          Copy links{chosenWithUrl.length ? ` (${chosenWithUrl.length})` : ""}
        </button>
        <button type="button" className="btn btn-ghost" disabled={!chosenWithUrl.length} onClick={() => copy("list")}>
          Copy with titles
        </button>
        {sortKey ? (
          <button type="button" className="btn btn-ghost" onClick={() => setSortKey(null)}>
            Reset sort
          </button>
        ) : null}
        {flash ? <span className="copy-flash" role="status">{flash}</span> : null}
        </div>
      </div>
      <div className="table-wrap">
        <table className="jobs">
          <thead>
            <tr>
              <th className="sel">
                <input type="checkbox" aria-label="Select all jobs" checked={allSelected} onChange={toggleAll} />
              </th>
              <Th k="company">Company</Th>
              <Th k="title">Title</Th>
              <Th k="location">Location</Th>
              <Th k="rank" title={PYTHON_RANK_TOOLTIP}>{PYTHON_RANK_LABEL}</Th>
              <Th k="fit" title={GPT_FIT_TOOLTIP}>{GPT_FIT_LABEL}</Th>
              <th>Lifecycle</th>
              <Th k="posted">Posted</Th>
              <Th k="first_seen">First seen</Th>
              <Th k="status">App status</Th>
              <Th k="source">Source</Th>
              <th>Open</th>
              {showActions ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((job) => {
              const id = jobId(job);
              const isSel = selected.has(id);
              return (
                <tr key={id} className={isSel ? "selected" : undefined}>
                  <td className="sel">
                    <input
                      type="checkbox"
                      aria-label={`Select ${String(job.title || "job")}`}
                      checked={isSel}
                      onChange={() => toggle(id)}
                    />
                  </td>
                  <td>{String(job.company || "—")}</td>
                  <td>
                    <Link href={`/dashboard/jobs/${id}`}>{String(job.title || "—")}</Link>
                    {job.previously_applied ? (
                      <div className="muted" style={{ fontSize: "0.78rem", marginTop: 2 }}>
                        Previously applied {formatDate(job.prior_applied_at)} (
                        {String(job.prior_application_status || "")})
                      </div>
                    ) : null}
                  </td>
                  <td>{String(job.posting_location || job.canonical_location || "—")}</td>
                  <td>{formatPythonRank(job.match_score)}</td>
                  <td title={gptFitTitle(job.gpt_evaluation_version)}>
                    {formatGptFit(job.gpt_relevance_score)}
                    {job.gpt_evaluation_version ? (
                      <span className="muted" style={{ display: "block", fontSize: "0.72rem" }}>
                        {String(job.gpt_evaluation_version)}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <JobBadges {...job} />
                  </td>
                  <td>{formatDate(job.posted_date)}</td>
                  <td>{formatDate(job.first_seen_at)}</td>
                  <td>{String(job.application_status || "—")}</td>
                  <td className="mono">{String(job.source || "—")}</td>
                  <td>
                    {job.url ? (
                      <a href={String(job.url)} target="_blank" rel="noreferrer">
                        Open Job
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  {showActions ? (
                    <td>
                      <div className="actions">
                        <MarkAppliedButton postingId={id} applicationUrl={job.url ? String(job.url) : undefined} />
                        <IgnoreButton postingId={id} />
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
