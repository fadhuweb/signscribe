import * as ort from "onnxruntime-web";
import type { LandmarkFrame, Hand } from "./landmarks";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/";
ort.env.wasm.numThreads = 1;

export const SEQ_LEN = 48; // frames per sign, must match training (T)
const FEAT = 134;

export type SignPred = { word: string; prob: number };
export type SignModel = { session: ort.InferenceSession; labels: string[] };

/** Load the trained sign model and its label list from /public. */
export async function loadSignModel(): Promise<SignModel> {
  // Cache-buster so a freshly swapped model is always used, never a stale copy.
  const v = "?v=" + Date.now();
  const buf = await fetch("/sign_model.onnx" + v, { cache: "no-store" }).then(
    (r) => r.arrayBuffer(),
  );
  const [session, labels] = await Promise.all([
    ort.InferenceSession.create(new Uint8Array(buf), {
      executionProviders: ["wasm"],
    }),
    fetch("/sign_labels.json" + v, { cache: "no-store" }).then(
      (r) => r.json() as Promise<string[]>,
    ),
  ]);
  return { session, labels };
}

function zeros67(): number[] {
  return new Array(67).fill(0);
}

/**
 * 134-number per-frame feature: for two hands (ordered left-to-right in the
 * image), presence + the wrist-centered handshape (63) + the wrist position
 * relative to the shoulders. A missing hand is all zeros. No pose-wrist
 * fallback: it must stay off so live matches the recorded training data.
 */
export function frameFeature(f: LandmarkFrame | null): number[] {
  if (!f) return zeros67().concat(zeros67());

  let midx = 0.5, midy = 0.5, midz = 0, width = 1;
  if (f.pose && f.pose.length >= 13) {
    const ls = f.pose[11];
    const rs = f.pose[12];
    midx = (ls.x + rs.x) / 2;
    midy = (ls.y + rs.y) / 2;
    midz = ((ls.z ?? 0) + (rs.z ?? 0)) / 2;
    width =
      Math.hypot(ls.x - rs.x, ls.y - rs.y, (ls.z ?? 0) - (rs.z ?? 0)) || 1e-6;
  }

  const hf = (h: Hand | undefined): number[] => {
    if (!h) return zeros67();
    const wrist = h.landmarks[0];
    const wp = [
      (wrist.x - midx) / width,
      (wrist.y - midy) / width,
      ((wrist.z ?? 0) - midz) / width,
    ];
    return [1, ...h.vector, ...wp];
  };

  const hands = [...f.hands].sort((a, b) => a.landmarks[0].x - b.landmarks[0].x);
  return hf(hands[0]).concat(hf(hands[1]));
}

/** Resample a variable-length feature sequence to SEQ_LEN frames. */
export function resample(seq: number[][], T = SEQ_LEN): number[][] {
  const n = seq.length;
  if (n === 0) return Array.from({ length: T }, () => new Array(FEAT).fill(0));
  const out: number[][] = [];
  for (let i = 0; i < T; i++) {
    out.push(seq[Math.round((i * (n - 1)) / (T - 1))]);
  }
  return out;
}

/** Run the model on a resampled sequence and return the top 3 words. */
export async function classifySequence(
  m: SignModel,
  seq: number[][],
): Promise<SignPred[]> {
  const T = seq.length;
  const flat = new Float32Array(T * FEAT);
  for (let t = 0; t < T; t++) {
    for (let j = 0; j < FEAT; j++) flat[t * FEAT + j] = seq[t][j];
  }
  const input = new ort.Tensor("float32", flat, [1, T, FEAT]);
  const output = await m.session.run({ input });
  const logits = output.logits.data as Float32Array;

  let mx = -Infinity;
  for (const v of logits) if (v > mx) mx = v;
  let sum = 0;
  const ex = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    ex[i] = Math.exp(logits[i] - mx);
    sum += ex[i];
  }
  const ranked = Array.from(ex, (v, i) => [v / sum, i] as [number, number]).sort(
    (a, b) => b[0] - a[0],
  );
  return ranked.slice(0, 3).map(([p, i]) => ({ word: m.labels[i] ?? "?", prob: p }));
}