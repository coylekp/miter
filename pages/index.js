import { useState, useEffect, useRef } from "react";

const OWNER_BY_PILLAR = {
  "HCM / Corrections": "HCM Support — Payroll Ops",
  "HCM / Reports": "HCM Support — Reporting",
  "HCM / Payroll": "HCM Support — Payroll Ops",
  "HCM / Taxes": "HCM Support — Tax",
  "Ecosystem / Sage & Integrations": "Integrations / Ecosystem team",
  "Platform / Other": "Platform Support",
  "Field Ops / Time tracking": "Field Ops Support",
};
const CATEGORIES = Object.keys(OWNER_BY_PILLAR);
function ownerFor(c) { return OWNER_BY_PILLAR[c] || "Support — General queue"; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED_TICKETS = [
  { id: 146085, category: "HCM / Corrections", title: "Urgent: how to cancel approved payroll", body: "We need to cancel a recently approved payroll because of incorrect bank information for an employee.", resolution: "Approved payrolls can only be canceled before the funding cutoff; once past cutoff, the fix must be a post-funding correction instead of a cancellation. Agent confirmed it was still cancelable, then walked the customer through cancel, bank detail correction, and resubmission." },
  { id: 127493, category: "HCM / Corrections", title: "Fringe benefit deduction misallocated to scale job", body: "An employee's deduction was mistakenly allocated to offset fringe on his scale/prevailing-wage job. How can this be corrected?", resolution: "Fringe offset allocation is set at the deduction-code level and applies to all jobs unless a job-specific override exists. Agent added a job-level override so the deduction excludes the scale job, then ran a correction to reverse the incorrect offset." },
  { id: 142465, category: "HCM / Reports", title: "EEO report format changed unexpectedly", body: "The EEO report used to have a different format, and it suddenly changed to one that's incompatible with the customer's reporting needs.", resolution: "EEO report format changes are driven by an annual compliance-spec update pushed to all customers at once, not a per-account bug. Agent confirmed the scheduled update, explained the new field mapping, and logged the incompatibility as product feedback." },
  { id: 132889, category: "HCM / Reports", title: "Imputed earnings column addition to Job Cost report", body: "Multiple customers have asked for an imputed earnings column to be added to the Job Cost report; it's intentionally not included today.", resolution: "This is a known, intentional product gap, not a bug. Agent explained the limitation and logged it as a recurring product request." },
  { id: 153039, category: "Ecosystem / Sage & Integrations", title: "Job ID not visible on reimbursement charges", body: "When charging reimbursements to a job, the job ID isn't visible — only the job name — which is a problem when many jobs share the same name.", resolution: "Reimbursement line items show job name by default; job ID visibility requires enabling an additional column in the reimbursement view settings. Agent enabled the job ID column and confirmed it resolved the ambiguity." },
  { id: 136085, category: "Ecosystem / Sage & Integrations", title: "Sub jobs not inheriting parent project properties in Sage Intacct sync", body: "After enabling sub jobs, newly synced sub jobs aren't inheriting the parent project's properties as expected.", resolution: "Sub-job property inheritance only applies to jobs created after the parent-child link is established in sync settings; jobs synced before don't retroactively inherit. Agent re-triggered a sync after confirming the parent link, which inherited properties going forward." },
  { id: 158220, category: "HCM / Reports", title: "Job Cost report unusably slow for large accounts", body: "The Job Cost report takes 10-15+ seconds to load, and sometimes times out completely, for accounts with a large number of active jobs.", resolution: "Confirmed this reproduces consistently on accounts with 500+ active jobs and isn't something the customer can work around from the UI. Escalated to engineering as a performance bug; agent set expectations with the customer and followed up once a fix shipped." },
  { id: 161045, category: "HCM / Reports", title: "Job Cost report still slow after last performance fix, very large accounts", body: "A customer with 1,000+ active jobs reports the Job Cost report is still taking 15+ seconds to load, even after the recent performance fix.", resolution: "Confirmed the account is well beyond the size the last fix was tested against. Escalated back to engineering as a follow-up performance issue; agent explained the earlier fix landed for typical accounts and this case needed further work." },
];

const SEED_ENG_ISSUES = [
  { id: "ENG-455", ticketId: 127493, team: "Payroll Engineering", title: "Fringe offset override doesn't survive payroll re-run", body: "When a payroll was recalculated after a correction, job-level fringe offset overrides reset to the deduction-code default, undoing manual overrides.", resolution: "Payroll re-run was reloading deduction rules from the code-level config instead of the job-level override table. Fixed recalculation to read job-level overrides first, falling back to the code-level default only when no override exists." },
  { id: "ENG-491", ticketId: 142465, team: "Platform Engineering", title: "EEO report generation broke after annual compliance update", body: "After the scheduled annual EEO compliance-spec update shipped, report generation started throwing a schema validation error for a subset of customers.", resolution: "The new spec added a required field that wasn't backfilled for accounts created before a certain date. Fixed by defaulting the field server-side for legacy accounts and backfilling it via migration." },
  { id: "ENG-507", ticketId: 136085, team: "Integrations Engineering", title: "Sage Intacct sync silently drops sub-job updates", body: "Sub-job property updates weren't propagating to Sage Intacct after the initial sync, with no error surfaced anywhere.", resolution: "The sync worker was catching and swallowing a 422 from Intacct's API when a sub-job's parent link was stale, then marking the sync as successful. Fixed by surfacing sync failures on the customer-facing sync status page and retrying with the refreshed parent link." },
  { id: "ENG-482", ticketId: 158220, team: "Platform Engineering", title: "Job Cost report times out for large multi-job accounts", body: "The Job Cost report endpoint was returning 504s for accounts with 500+ active jobs, blocking report generation entirely.", resolution: "The report query was doing an N+1 lookup per job for labor allocations. Fixed by batching the labor allocation query and adding a covering index on (job_id, pay_period). Added a query timeout with a pagination fallback for very large accounts." },
  { id: "ENG-540", ticketId: 161045, team: "Platform Engineering", title: "Job Cost report still slow for 1000+ job accounts after batching fix", body: "Accounts with more than 1000 active jobs still see 15s+ load times on the Job Cost report even after the N+1 fix shipped.", resolution: "Batching fixed the N+1 pattern, but the report still loaded the full job list client-side. Added server-side pagination with a job search/filter so large accounts don't have to load everything at once." },
];

const ENG_ISSUE_BY_TICKET = Object.fromEntries(SEED_ENG_ISSUES.map((i) => [i.ticketId, i]));
const TICKET_BY_ENG_ISSUE = Object.fromEntries(SEED_ENG_ISSUES.map((i) => [i.id, i.ticketId]));

function buildPrompt(ticket, library) {
  const existing = library.length === 0 ? "none yet" : library.map((s) => `id=${s.id} | Title: ${s.title} | Problem: ${s.problem} | Cause: ${s.cause}`).join("\n");
  return `You maintain a library of reusable support SOPs for Miter (construction SaaS). A resolved support ticket arrived. Decide one of:
- NEW: no existing SOP covers this issue -> write a new SOP.
- SKIP: an existing SOP already fully covers it, nothing new to add.
- MERGE: same underlying issue as an existing SOP, but this ticket adds a useful new cause/edge case/step -> output the updated SOP.

New ticket:
Category: ${ticket.category}
Customer question: ${ticket.body}
Resolution: ${ticket.resolution}

Existing SOPs:
${existing}

Reply in EXACTLY this format, each field on ONE line, nothing else:
Decision: NEW or SKIP or MERGE
MatchId: existing SOP id or NONE
Reason: one short sentence
Title: SOP title
Problem: one line
Cause: one line
Steps: step | step | step

For SKIP, repeat the matched SOP's existing content. For MERGE, output the full updated SOP.`;
}

function buildRunbookPrompt(issue, library) {
  const existing = library.length === 0 ? "none yet" : library.map((r) => `id=${r.id} | Title: ${r.title} | Problem: ${r.problem} | Cause: ${r.cause}`).join("\n");
  return `You maintain an internal engineering runbook of resolved technical issues for Miter (construction SaaS). A resolved Linear issue arrived. Decide one of:
- NEW: no existing runbook entry covers this issue -> write a new entry.
- SKIP: an existing entry already fully covers it, nothing new to add.
- MERGE: same underlying issue as an existing entry, but this issue adds a useful new cause/edge case/step -> output the updated entry.

New issue:
Team: ${issue.team}
Issue description: ${issue.body}
Engineering resolution: ${issue.resolution}

Existing runbook entries:
${existing}

Reply in EXACTLY this format, each field on ONE line, nothing else:
Decision: NEW or SKIP or MERGE
MatchId: existing entry id or NONE
Reason: one short sentence
Title: runbook entry title
Problem: one line
Cause: one line
Steps: step | step | step

For SKIP, repeat the matched entry's existing content. For MERGE, output the full updated entry.`;
}

function parse(text) {
  const o = { decision: "NEW", matchId: "NONE", reason: "", title: "", problem: "", cause: "", steps: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(Decision|MatchId|Reason|Title|Problem|Cause|Steps)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(); const v = m[2].trim();
    if (k === "decision") { const d = v.toUpperCase(); o.decision = d.includes("SKIP") ? "SKIP" : d.includes("MERGE") ? "MERGE" : "NEW"; }
    else if (k === "matchid") o.matchId = v;
    else if (k === "reason") o.reason = v;
    else if (k === "title") o.title = v;
    else if (k === "problem") o.problem = v;
    else if (k === "cause") o.cause = v;
    else if (k === "steps") o.steps = v.split("|").map((s) => s.trim()).filter(Boolean);
  }
  return o;
}

async function callModel(prompt) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const block = (data.content || []).find((b) => b.type === "text");
      if (!block) throw new Error("Model response had no text content");
      return block.text.trim();
    } catch (e) { lastErr = e; await sleep(700); }
  }
  throw lastErr;
}

function sopToText(s) {
  return [s.title, "", `Owner: ${s.owner}`, `Work area: ${s.category}`, `Source tickets: ${s.sourceTickets.map((t) => "#" + t).join(", ")}`, `Last updated: ${s.updated}`, "", "Problem", s.problem, "", "Cause", s.cause, "", "Resolution steps", ...s.steps.map((x, i) => `${i + 1}. ${x}`)].join("\n");
}

let counter = 1;
const newId = () => "SOP-" + String(counter++).padStart(3, "0");

function runbookEntryToText(r) {
  return [r.title, "", `Team: ${r.team}`, `Source issues: ${r.sourceIssues.join(", ")}`, `Last updated: ${r.updated}`, "", "Problem", r.problem, "", "Cause", r.cause, "", "Resolution steps", ...r.steps.map((x, i) => `${i + 1}. ${x}`)].join("\n");
}

let runbookCounter = 1;
const newRunbookId = () => "RUN-" + String(runbookCounter++).padStart(3, "0");

export default function MiterExercise() {
  const [library, setLibrary] = useState([]);
  const [log, setLog] = useState([]);
  const [copiedId, setCopiedId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: "", category: CATEGORIES[0], body: "", resolution: "" });
  const libRef = useRef([]);
  const started = useRef(false);
  const logSeq = useRef(0);
  const today = new Date().toISOString().slice(0, 10);

  const [runbook, setRunbook] = useState([]);
  const [runbookCopiedId, setRunbookCopiedId] = useState(null);
  const runbookRef = useRef([]);

  const addLog = (e) => { const logId = ++logSeq.current; setLog((p) => [{ ...e, logId }, ...p]); return logId; };
  const setLogRow = (logId, patch) => setLog((p) => p.map((e) => (e.logId === logId ? { ...e, ...patch } : e)));

  async function processIssue(issue) {
    const raw = await callModel(buildRunbookPrompt(issue, runbookRef.current));
    const d = parse(raw);
    if (d.decision === "SKIP" && runbookRef.current.some((r) => r.id === d.matchId)) {
      return { status: "skipped", reason: d.reason, matchId: d.matchId };
    }
    if (d.decision === "MERGE") {
      const idx = runbookRef.current.findIndex((r) => r.id === d.matchId);
      if (idx >= 0) {
        const ex = runbookRef.current[idx];
        const upd = { ...ex, title: d.title || ex.title, problem: d.problem || ex.problem, cause: d.cause || ex.cause, steps: d.steps.length ? d.steps : ex.steps, sourceIssues: [...ex.sourceIssues, issue.id], updated: today, mergedCount: (ex.mergedCount || 1) + 1 };
        const next = [...runbookRef.current]; next[idx] = upd;
        runbookRef.current = next; setRunbook(next);
        return { status: "merged", reason: d.reason, matchId: ex.id };
      }
    }
    const entry = { id: newRunbookId(), title: d.title || issue.title, problem: d.problem, cause: d.cause, steps: d.steps, team: issue.team, sourceIssues: [issue.id], updated: today, mergedCount: 1, published: false };
    const next = [...runbookRef.current, entry];
    runbookRef.current = next; setRunbook(next);
    return { status: "created", reason: d.reason, matchId: entry.id };
  }

  async function processTicket(ticket, linkedIssue) {
    const logId = addLog({ ticketId: ticket.id, title: ticket.title, status: "processing", engIssue: linkedIssue ? { id: linkedIssue.id, status: "processing" } : null });
    try {
      const raw = await callModel(buildPrompt(ticket, libRef.current));
      const d = parse(raw);
      if (d.decision === "SKIP" && libRef.current.some((s) => s.id === d.matchId)) {
        setLogRow(logId, { status: "skipped", reason: d.reason, matchId: d.matchId });
      } else if (d.decision === "MERGE" && libRef.current.some((s) => s.id === d.matchId)) {
        const idx = libRef.current.findIndex((s) => s.id === d.matchId);
        const ex = libRef.current[idx];
        const upd = { ...ex, title: d.title || ex.title, problem: d.problem || ex.problem, cause: d.cause || ex.cause, steps: d.steps.length ? d.steps : ex.steps, sourceTickets: [...ex.sourceTickets, ticket.id], updated: today, mergedCount: (ex.mergedCount || 1) + 1 };
        const next = [...libRef.current]; next[idx] = upd;
        libRef.current = next; setLibrary(next);
        setLogRow(logId, { status: "merged", reason: d.reason, matchId: ex.id });
      } else {
        const sop = { id: newId(), title: d.title || ticket.title, problem: d.problem, cause: d.cause, steps: d.steps, owner: ownerFor(ticket.category), category: ticket.category, sourceTickets: [ticket.id], updated: today, mergedCount: 1, published: false };
        const next = [...libRef.current, sop];
        libRef.current = next; setLibrary(next);
        setLogRow(logId, { status: "created", reason: d.reason, matchId: sop.id });
      }
    } catch (e) {
      setLogRow(logId, { status: "error", reason: (e && e.message) || "error" });
    }

    if (linkedIssue) {
      try {
        const result = await processIssue(linkedIssue);
        setLogRow(logId, { engIssue: { id: linkedIssue.id, ...result } });
      } catch (e) {
        setLogRow(logId, { engIssue: { id: linkedIssue.id, status: "error", reason: (e && e.message) || "error" } });
      }
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      setBusy(true);
      for (const t of SEED_TICKETS) {
        await processTicket(t, ENG_ISSUE_BY_TICKET[t.id]);
        await sleep(400);
      }
      setBusy(false);
    })();
  }, []);

  function publishRunbook(id) {
    const next = runbookRef.current.map((r) => (r.id === id ? { ...r, published: true } : r));
    runbookRef.current = next; setRunbook(next);
  }
  function copyRunbook(id, text) {
    navigator.clipboard.writeText(text).then(() => { setRunbookCopiedId(id); setTimeout(() => setRunbookCopiedId((c) => (c === id ? null : c)), 2000); });
  }

  async function addTicket() {
    if (!form.title.trim() || !form.body.trim() || !form.resolution.trim()) return;
    const t = { id: Math.floor(100000 + Math.random() * 900000), category: form.category, title: form.title.trim(), body: form.body.trim(), resolution: form.resolution.trim() };
    setForm({ title: "", category: CATEGORIES[0], body: "", resolution: "" });
    setShowForm(false); setBusy(true);
    await processTicket(t, undefined); setBusy(false);
  }

  function publish(id) {
    const next = libRef.current.map((s) => (s.id === id ? { ...s, published: true } : s));
    libRef.current = next; setLibrary(next);
  }
  function copy(id, text) {
    navigator.clipboard.writeText(text).then(() => { setCopiedId(id); setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 2000); });
  }

  const stStyle = { processing: "text-slate-500", created: "text-green-700 bg-green-50", merged: "text-amber-700 bg-amber-50", skipped: "text-slate-500 bg-slate-100", error: "text-red-700 bg-red-50" };
  const stLabel = { processing: "Processing…", created: "Created new SOP", merged: "Merged into existing", skipped: "Skipped — duplicate", error: "Error" };
  const engStLabel = { processing: "Processing…", created: "Created runbook entry", merged: "Merged into existing", skipped: "Skipped — duplicate", error: "Error" };

  return (
    <div className="max-w-3xl mx-auto p-6 text-slate-800">
      <div className="flex justify-between items-start mb-1 gap-4">
        <h1 className="text-xl font-medium">Ticket → SOP Pipeline</h1>
        <button onClick={() => setShowForm((v) => !v)} disabled={busy} className="text-sm font-medium border border-slate-300 rounded-md px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap">{showForm ? "Close" : "+ Add test ticket"}</button>
      </div>
      <p className="text-sm text-slate-500 mb-4">A closed Pylon ticket is read by the LLM, checked against the existing SOP library, then it creates a new SOP, merges new detail into an existing one, or skips it as a duplicate. If the ticket was escalated to engineering, its linked Linear ticket is processed the same way into the engineering runbook below.</p>
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 mb-5 text-sm text-slate-600">Tickets synced from Pylon (simulated — Workato pulls these in production). Not every ticket has a linked engineering ticket — that's called out explicitly in the activity feed. New SOPs publish to Google Drive, runbook entries publish to Notion (both simulated). Use "Add test ticket" to paste any new issue — try one similar to an existing SOP to see the pipeline merge or skip it.</div>

      {showForm && (
        <div className="bg-white border border-slate-300 rounded-xl p-4 mb-5">
          <p className="text-sm font-medium mb-3">Add a test Pylon ticket</p>
          <div className="flex flex-col gap-3">
            <div><label className="text-xs text-slate-500 block mb-1">Ticket title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. How do I undo a payroll I already approved?" className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-500 block mb-1">Work area</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white">{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div><label className="text-xs text-slate-500 block mb-1">Customer's question / message</label><textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={2} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" /></div>
            <div><label className="text-xs text-slate-500 block mb-1">How it was resolved</label><textarea value={form.resolution} onChange={(e) => setForm({ ...form, resolution: e.target.value })} rows={2} className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm" /></div>
            <button onClick={addTicket} disabled={busy} className="text-sm font-medium bg-slate-800 text-white rounded-md px-4 py-2 hover:bg-slate-700 disabled:opacity-50 self-start">Process ticket</button>
          </div>
        </div>
      )}

      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Activity</p>
      <div className="flex flex-col gap-1.5 mb-6">
        {log.length === 0 && <p className="text-sm text-slate-400">Processing tickets…</p>}
        {log.map((e) => {
          const errText = [e.status === "error" && e.reason, e.engIssue && e.engIssue.status === "error" && e.engIssue.reason].filter(Boolean).join(" · ");
          return (
            <div key={e.logId} className="flex flex-col gap-0.5 text-sm bg-white border border-slate-100 rounded-lg px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-700 truncate">#{e.ticketId} · {e.title}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={`text-xs px-2 py-0.5 rounded-md whitespace-nowrap ${stStyle[e.status] || ""}`}>{stLabel[e.status] || e.status}{e.matchId && (e.status === "merged" || e.status === "skipped") ? ` (${e.matchId})` : ""}</span>
                  {e.engIssue ? (
                    <span className={`text-xs px-2 py-0.5 rounded-md whitespace-nowrap font-mono ${stStyle[e.engIssue.status] || ""}`} title={`Linked engineering ticket ${e.engIssue.id}`}>{e.engIssue.id} · {engStLabel[e.engIssue.status] || e.engIssue.status}</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded-md whitespace-nowrap text-slate-400 bg-slate-50" title="No linked engineering ticket">no eng ticket</span>
                  )}
                </div>
              </div>
              {errText && <span className="text-xs text-red-600">{errText}</span>}
            </div>
          );
        })}
      </div>

      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">SOP library ({library.length})</p>
      <div className="flex flex-col gap-3 mb-8">
        {library.map((s) => (
          <div key={s.id} className="bg-white border border-slate-200 border-l-4 border-l-blue-500 rounded-xl p-4">
            <div className="flex justify-between items-start gap-3 mb-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold tracking-wide text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">SOP</span>
                <h2 className="text-base font-medium">{s.title}</h2>
              </div>
              {s.mergedCount > 1 && <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-md whitespace-nowrap">Merged · {s.mergedCount} tickets</span>}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-500 mb-3 bg-slate-50 rounded-md p-2.5">
              <div><span className="text-slate-400">SOP ID: </span>{s.id}</div>
              <div><span className="text-slate-400">Owner: </span>{s.owner}</div>
              <div><span className="text-slate-400">Work area: </span>{s.category}</div>
              <div><span className="text-slate-400">Source tickets: </span>{s.sourceTickets.map((t) => "#" + t).join(", ")}</div>
            </div>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Problem</p>
            <p className="text-[13px] text-slate-700 mb-3 leading-relaxed">{s.problem}</p>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Cause</p>
            <p className="text-[13px] text-slate-700 mb-3 leading-relaxed">{s.cause}</p>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Resolution steps</p>
            <ol className="list-decimal list-inside text-[13px] text-slate-700 mb-3 leading-relaxed space-y-0.5">{s.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
            <div className="flex items-center gap-2">
              {s.published ? <span className="text-xs text-green-700 bg-green-50 px-2 py-1 rounded-md">Published to Drive</span> : <button onClick={() => publish(s.id)} className="text-sm font-medium bg-slate-800 text-white rounded-md px-3 py-1 hover:bg-slate-700">Publish to Drive</button>}
              <button onClick={() => copy(s.id, sopToText(s))} className="text-sm font-medium border border-slate-300 rounded-md px-3 py-1 hover:bg-slate-50">Copy</button>
              {copiedId === s.id && <span className="text-xs text-green-600 ml-1">Copied</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-slate-200 pt-6">
        <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Runbook entries ({runbook.length})</p>
        <p className="text-sm text-slate-500 mb-4">Created from engineering (Linear) tickets linked to the support tickets above — only tickets that were escalated to engineering produce one of these.</p>
        <div className="flex flex-col gap-3">
          {runbook.map((r) => (
            <div key={r.id} className="bg-slate-900 text-slate-100 border border-slate-900 border-l-4 border-l-violet-500 rounded-xl p-4">
              <div className="flex justify-between items-start gap-3 mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold tracking-wide text-violet-300 bg-violet-950 px-1.5 py-0.5 rounded">RUNBOOK</span>
                  <h2 className="text-base font-medium font-mono">{r.title}</h2>
                </div>
                {r.mergedCount > 1 && <span className="text-xs text-amber-300 bg-amber-950 px-2 py-0.5 rounded-md whitespace-nowrap">Merged · {r.mergedCount} issues</span>}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400 mb-3 bg-slate-800 rounded-md p-2.5 font-mono">
                <div><span className="text-slate-500">Runbook ID: </span>{r.id}</div>
                <div><span className="text-slate-500">Team: </span>{r.team}</div>
                <div><span className="text-slate-500">Source issues: </span>{r.sourceIssues.join(", ")}</div>
                <div><span className="text-slate-500">Source tickets: </span>{[...new Set(r.sourceIssues.map((i) => TICKET_BY_ENG_ISSUE[i]).filter(Boolean))].map((t) => "#" + t).join(", ") || "—"}</div>
              </div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Problem</p>
              <p className="text-[13px] text-slate-200 mb-3 leading-relaxed">{r.problem}</p>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Cause</p>
              <p className="text-[13px] text-slate-200 mb-3 leading-relaxed">{r.cause}</p>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Resolution steps</p>
              <ol className="list-decimal list-inside text-[13px] text-slate-200 mb-3 leading-relaxed space-y-0.5">{r.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
              <div className="flex items-center gap-2">
                {r.published ? <span className="text-xs text-green-300 bg-green-950 px-2 py-1 rounded-md">Published to Notion</span> : <button onClick={() => publishRunbook(r.id)} className="text-sm font-medium bg-violet-600 text-white rounded-md px-3 py-1 hover:bg-violet-500">Publish to Notion</button>}
                <button onClick={() => copyRunbook(r.id, runbookEntryToText(r))} className="text-sm font-medium border border-slate-700 text-slate-200 rounded-md px-3 py-1 hover:bg-slate-800">Copy</button>
                {runbookCopiedId === r.id && <span className="text-xs text-green-400 ml-1">Copied</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
