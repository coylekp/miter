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
];

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
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const block = (data.content || []).find((b) => b.type === "text");
      return block ? block.text.trim() : "";
    } catch (e) { lastErr = e; await sleep(700); }
  }
  throw lastErr;
}

function sopToText(s) {
  return [s.title, "", `Owner: ${s.owner}`, `Work area: ${s.category}`, `Source tickets: ${s.sourceTickets.map((t) => "#" + t).join(", ")}`, `Last updated: ${s.updated}`, "", "Problem", s.problem, "", "Cause", s.cause, "", "Resolution steps", ...s.steps.map((x, i) => `${i + 1}. ${x}`)].join("\n");
}

let counter = 1;
const newId = () => "SOP-" + String(counter++).padStart(3, "0");

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

  const addLog = (e) => { const logId = ++logSeq.current; setLog((p) => [{ ...e, logId }, ...p]); return logId; };
  const setLogRow = (logId, patch) => setLog((p) => p.map((e) => (e.logId === logId ? { ...e, ...patch } : e)));

  async function processTicket(ticket) {
    const logId = addLog({ ticketId: ticket.id, title: ticket.title, status: "processing" });
    try {
      const raw = await callModel(buildPrompt(ticket, libRef.current));
      const d = parse(raw);
      if (d.decision === "SKIP" && libRef.current.some((s) => s.id === d.matchId)) {
        setLogRow(logId, { status: "skipped", reason: d.reason, matchId: d.matchId }); return;
      }
      if (d.decision === "MERGE") {
        const idx = libRef.current.findIndex((s) => s.id === d.matchId);
        if (idx >= 0) {
          const ex = libRef.current[idx];
          const upd = { ...ex, title: d.title || ex.title, problem: d.problem || ex.problem, cause: d.cause || ex.cause, steps: d.steps.length ? d.steps : ex.steps, sourceTickets: [...ex.sourceTickets, ticket.id], updated: today, mergedCount: (ex.mergedCount || 1) + 1 };
          const next = [...libRef.current]; next[idx] = upd;
          libRef.current = next; setLibrary(next);
          setLogRow(logId, { status: "merged", reason: d.reason, matchId: ex.id }); return;
        }
      }
      const sop = { id: newId(), title: d.title || ticket.title, problem: d.problem, cause: d.cause, steps: d.steps, owner: ownerFor(ticket.category), category: ticket.category, sourceTickets: [ticket.id], updated: today, mergedCount: 1, published: false };
      const next = [...libRef.current, sop];
      libRef.current = next; setLibrary(next);
      setLogRow(logId, { status: "created", reason: d.reason, matchId: sop.id });
    } catch (e) {
      setLogRow(logId, { status: "error", reason: (e && e.message) || "error" });
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => { setBusy(true); for (const t of SEED_TICKETS) { await processTicket(t); await sleep(400); } setBusy(false); })();
  }, []);

  async function addTicket() {
    if (!form.title.trim() || !form.body.trim() || !form.resolution.trim()) return;
    const t = { id: Math.floor(100000 + Math.random() * 900000), category: form.category, title: form.title.trim(), body: form.body.trim(), resolution: form.resolution.trim() };
    setForm({ title: "", category: CATEGORIES[0], body: "", resolution: "" });
    setShowForm(false); setBusy(true);
    await processTicket(t); setBusy(false);
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

  return (
    <div className="max-w-3xl mx-auto p-6 text-slate-800">
      <div className="flex justify-between items-start mb-1 gap-4">
        <h1 className="text-xl font-medium">Ticket → SOP Pipeline</h1>
        <button onClick={() => setShowForm((v) => !v)} disabled={busy} className="text-sm font-medium border border-slate-300 rounded-md px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap">{showForm ? "Close" : "+ Add test ticket"}</button>
      </div>
      <p className="text-sm text-slate-500 mb-4">A closed Pylon ticket is read by the LLM, checked against the existing SOP library, then it creates a new SOP, merges new detail into an existing one, or skips it as a duplicate.</p>
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 mb-5 text-sm text-slate-600">Tickets synced from Pylon (simulated — Workato pulls these in production). New SOPs publish to a shared Google Drive folder in production. Use "Add test ticket" to paste any new issue — try one similar to an existing SOP to see the pipeline merge or skip it.</div>

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
        {log.map((e) => (
          <div key={e.logId} className="flex items-center justify-between gap-3 text-sm bg-white border border-slate-100 rounded-lg px-3 py-2">
            <span className="text-slate-700 truncate">#{e.ticketId} · {e.title}</span>
            <span className={`text-xs px-2 py-0.5 rounded-md whitespace-nowrap ${stStyle[e.status] || ""}`}>{stLabel[e.status] || e.status}{e.matchId && (e.status === "merged" || e.status === "skipped") ? ` (${e.matchId})` : ""}</span>
          </div>
        ))}
      </div>

      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">SOP library ({library.length})</p>
      <div className="flex flex-col gap-3">
        {library.map((s) => (
          <div key={s.id} className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex justify-between items-start gap-3 mb-2">
              <h2 className="text-base font-medium">{s.title}</h2>
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
    </div>
  );
}
