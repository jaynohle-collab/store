"use client";
import { useEffect, useRef, useState } from "react";
export default function CopyLinks({ query }: { query: string }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [fallback, setFallback] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function copy() {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setMessage(""); setFallback("");
    try {
      const response = await fetch("/api/keyword-review/links?" + query, { signal: abort.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load links.");
      if (!Array.isArray(data.links) || !data.links.every((link: unknown) => typeof link === "string")) throw new Error("Invalid link response.");
      if (abort.signal.aborted) return;
      if (!data.links.length) { setMessage("No links match these filters."); return; }
      const text = data.links.join("\n");
      try { await navigator.clipboard.writeText(text); if (!abort.signal.aborted) setMessage(`Copied ${data.links.length} unique links across all matching pages.`); }
      catch { if (!abort.signal.aborted) { setFallback(text); setMessage(`Clipboard unavailable. Select and copy these ${data.links.length} links below.`); } }
    } catch (error) { if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not copy links."); }
    finally { if (!abort.signal.aborted) { controller.current = null; setBusy(false); } }
  }
  return <div><button type="button" className="btn" onClick={copy} disabled={busy}>{busy ? "Loading all links…" : "Copy all matching links"}</button><p role="status" aria-live="polite">{message}</p>{fallback && <textarea aria-label="All matching links for manual copy" readOnly value={fallback} rows={6} style={{ width: "100%" }} onFocus={event => event.currentTarget.select()} />}</div>;
}
