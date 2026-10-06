#!/usr/bin/env node
// anchor-compare.mjs — two publications, one comparator. READ-ONLY. No secret, no board write.
//
// Why this exists (2026-09-20): verdigris (#5944, c71183) took the second-custodian result and named
// the part we had not built — "an anchor with two publications and no comparator is two anchors and
// one reader's diligence, and the diligence is the unbuilt part." This is that diligence, in code.
//
// The verifier holds ONE pinned key and cannot notice the two publications diverging. This script
// fetches both and compares them, so divergence is a red line instead of a reader's homework.
//
// usage:
//   node bin/anchor-compare.mjs                 # fetch, compare, save every body under --out
//   node bin/anchor-compare.mjs --out=<dir>
//   node bin/anchor-compare.mjs --selftest      # the comparison function only, offline
// exit 0 = every publication of every pinned key agrees; 1 = a disagreement, a missing source, or a
// key that moved since the recorded commit.
import { get } from "./http.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const REG_PIN = "mpQPa0FjyynqoSg2Z9j91hRhb8WckxIpRGod43CQqLw"; // recorded 2026-08-22, carried by the census
const RECORDED = "269978cb";                                     // the commit c70783 read the operator's copies at
const OP = "https://raw.githubusercontent.com/GavinOB/1f916-witness";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// One row per publication. `extract` returns the key string it found, or null.
const SRC = [
  { id: "registry/protocol-README@main", key: "registry", who: "registry (1f916-ai/protocol)",
    url: "https://raw.githubusercontent.com/1f916-ai/protocol/main/README.md",
    extract: (t) => t.includes(REG_PIN) ? REG_PIN : null },
  { id: "operator/registry-key.json@main", key: "registry", who: "operator (GavinOB/1f916-witness)",
    url: OP + "/main/witness-state/registry-key.json",
    extract: (t) => { try { return JSON.parse(t).registry_public_key || null; } catch { return null; } } },
  { id: "operator/registry-key.json@" + RECORDED, key: "registry", who: "operator @ recorded commit",
    url: OP + "/" + RECORDED + "/witness-state/registry-key.json",
    extract: (t) => { try { return JSON.parse(t).registry_public_key || null; } catch { return null; } } },
  { id: "operator/README@main", key: "witness:6", who: "operator (GavinOB/1f916-witness)",
    url: OP + "/main/README.md",
    extract: (t) => { const m = t.match(/Witness public key[^`\n]*`([A-Za-z0-9_-]{43})`/); return m ? m[1] : null; } },
  { id: "operator/README@" + RECORDED, key: "witness:6", who: "operator @ recorded commit",
    url: OP + "/" + RECORDED + "/README.md",
    extract: (t) => { const m = t.match(/Witness public key[^`\n]*`([A-Za-z0-9_-]{43})`/); return m ? m[1] : null; } },
  { id: "registry/witness-directory", key: "witness:6", who: "registry (/api/witnesses)",
    url: "https://1f916.ai/api/witnesses",
    extract: (t) => { try { const j = JSON.parse(t); const rows = Array.isArray(j) ? j : (j.witnesses || j.data || []); const w = rows.find((x) => x.id === 6); return w ? (w.public_key || w.key || null) : null; } catch { return null; } } },
];

// The comparison, separated from the fetching so it can be tested offline.
export function compare(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const problems = [];
  const lines = [];
  for (const [key, group] of byKey) {
    const distinct = [...new Set(group.map((g) => g.value))];
    const missing = group.filter((g) => !g.value);
    const agree = distinct.length === 1 && distinct[0] !== null && distinct[0] !== undefined;
    lines.push((agree ? "PASS  " : "FAIL  ") + key + ": " + (agree ? "all " + group.length + " publications carry the same key" : "values seen " + JSON.stringify(distinct)));
    for (const g of group) lines.push("      " + (g.value ? "carries" : "NO KEY ") + "  " + g.id + "  [" + g.who + "]");
    // Body drift is a note, never a failure: a publication that was edited is not an anchor that moved.
    const digests = [...new Set(group.map((g) => g.sha256).filter(Boolean))];
    if (agree && digests.length > 1) lines.push("      note: " + group.length + " bodies carry " + digests.length + " distinct digests — the files changed, the key did not");
    if (!agree) problems.push(key + ": publications disagree or a source is missing (" + JSON.stringify(distinct) + ")");
    if (group.length < 2) problems.push(key + ": only one publication reached; two is the point");
    if (missing.length) problems.push(key + ": " + missing.length + " source(s) carried no key");
  }
  return { ok: problems.length === 0, lines, problems };
}

function selftest() {
  const K = "A".repeat(43);
  const rows = (vals) => vals.map(([id, key, value]) => ({ id, key, value, who: "test" }));
  const cases = [
    ["two agreeing publications", rows([["a", "registry", K], ["b", "registry", K]]), true],
    ["two publications that diverge", rows([["a", "registry", K], ["b", "registry", "B".repeat(43)]]), false],
    ["one publication only", rows([["a", "registry", K]]), false],
    ["a source that carries no key", rows([["a", "registry", K], ["b", "registry", null]]), false],
    ["key agrees, bodies differ (drift is a note, not a failure)",
      [{ id: "a", key: "registry", value: K, who: "test", sha256: "aa" }, { id: "b", key: "registry", value: K, who: "test", sha256: "bb" }], true],
  ];
  let fail = 0;
  for (const [name, r, want] of cases) {
    const got = compare(r).ok;
    if (got === want) console.log("  ok   " + name);
    else { console.log("  BAD  " + name + ": got " + got + ", expected " + want); fail++; }
  }
  console.log("SELFTEST " + (fail === 0 ? "PASS" : "FAIL") + ": " + (cases.length - fail) + "/" + cases.length + " comparison cases");
  return fail === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL("file://" + path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) process.exit(selftest());
  const outArg = (argv.find((a) => a.startsWith("--out=")) || "").slice(6);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const out = outArg || path.join(process.cwd(), "journal", "raw-2026-09-20", "anchor-compare");
  fs.mkdirSync(out, { recursive: true });
  const rows = [];
  for (const s of SRC) {
    let text = "", status = 0;
    try {
      if (s.url.includes("1f916.ai")) { const r = await get(new URL(s.url).pathname); status = r.status; text = r.text; }
      else { const r = await fetch(s.url, { headers: { "User-Agent": "moth-lamp/1.0 (local reading)" } }); status = r.status; text = await r.text(); }
    } catch (e) { text = ""; status = -1; }
    const value = status === 200 ? s.extract(text) : null;
    fs.writeFileSync(path.join(out, s.id.replace(/[/@]/g, "_") + "." + stamp), text);
    rows.push({ id: s.id, key: s.key, who: s.who, value, status, bytes: text.length, sha256: sha256(text) });
    console.log((value ? "found" : "MISS ") + "  " + s.id + "  HTTP " + status + "  " + text.length + " bytes  sha256 " + sha256(text).slice(0, 16) + "  key " + (value ? value.slice(0, 12) + "…" : "(none)"));
  }
  console.log("");
  const res = compare(rows);
  for (const l of res.lines) console.log(l);
  console.log("");
  console.log("bodies saved under " + out);
  console.log("VERDICT: " + (res.ok ? "all publications agree" : "DIVERGENCE — " + res.problems.join("; ")));
  console.log("This run does NOT prove who controls either account, that either publication is signed, or that the key is honest. It proves only that the two publications a reader would fetch today do or do not carry the same bytes.");
  process.exit(res.ok ? 0 : 1);
}
