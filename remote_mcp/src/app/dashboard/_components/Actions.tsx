"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function MarkAppliedButton({
  postingId,
  applicationUrl,
}: {
  postingId: string;
  applicationUrl?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          posting_id: postingId,
          application_url: applicationUrl,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "Failed to mark applied");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn" disabled={busy} onClick={onClick}>
      {busy ? "Saving…" : "Mark Applied"}
    </button>
  );
}

export function IgnoreButton({ postingId }: { postingId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${postingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ignore" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "Failed to ignore");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClick}>
      Ignore
    </button>
  );
}

export function UndoAppliedButton({ applicationId }: { applicationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function onClick() {
    if (busy) return;
    const confirmed = window.confirm(
      "Undo Mark Applied for this posting? This returns it to To Apply when still eligible. Application history is preserved.",
    );
    if (!confirmed) return;

    setBusy(true);
    setMessage(null);
    setIsError(false);
    try {
      const res = await fetch(`/api/applications/${applicationId}/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setIsError(true);
        setMessage(typeof body.error === "string" ? body.error : "Failed to undo applied status");
        return;
      }
      setMessage("Application undone. Refreshing…");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="undo-action">
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClick}>
        {busy ? "Undoing…" : "Undo Applied"}
      </button>
      {message ? (
        <span className={isError ? "form-message form-message-error" : "form-message"} role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}

export function StatusUpdateForm({
  applicationId,
  currentStatus,
}: {
  applicationId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(currentStatus);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(`/api/applications/${applicationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, notes: notes || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || "Failed to update status");
        return;
      }
      setNotes("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="toolbar" style={{ marginTop: "0.75rem" }}>
      <select value={status} onChange={(e) => setStatus(e.target.value)}>
        {[
          "planned",
          "applied",
          "recruiter_screen",
          "technical_screen",
          "interview",
          "onsite",
          "offer",
          "rejected",
          "withdrawn",
          "closed",
        ].map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        style={{ minWidth: 180 }}
      />
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "Saving…" : "Update status"}
      </button>
    </form>
  );
}
