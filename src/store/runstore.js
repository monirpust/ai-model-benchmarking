'use strict';
// File-system run store: every run lives in runs/<runId>/ as plain JSON so it
// is inspectable, diffable and easy to package for reproducibility.
// The unblinding key (blind code -> candidate) is kept in a separate file.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.env.GENBENCH_RUNS_DIR || path.join(__dirname, '..', '..', 'runs'));

function runDir(runId) {
  if (!/^[\w-]+$/.test(runId)) throw new Error('invalid run id');
  return path.join(ROOT, runId);
}

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

function write(runId, name, data) {
  const dir = ensure(runDir(runId));
  const file = path.join(dir, name);
  ensure(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function read(runId, name, fallback = undefined) {
  const file = path.join(runDir(runId), name);
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function exists(runId) { return fs.existsSync(runDir(runId)); }

function listRuns() {
  if (!fs.existsSync(ROOT)) return [];
  return fs.readdirSync(ROOT).filter((d) => fs.existsSync(path.join(ROOT, d, 'status.json')))
    .map((d) => read(d, 'status.json')).filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Append-only human ratings log (one JSON object per line). */
function appendRating(runId, rating) {
  const dir = ensure(path.join(runDir(runId), 'human'));
  fs.appendFileSync(path.join(dir, 'ratings.jsonl'), JSON.stringify(rating) + '\n');
}

function readRatings(runId) {
  const file = path.join(runDir(runId), 'human', 'ratings.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function deleteRun(runId) { fs.rmSync(runDir(runId), { recursive: true, force: true }); }

module.exports = { ROOT, runDir, write, read, exists, listRuns, appendRating, readRatings, deleteRun };
