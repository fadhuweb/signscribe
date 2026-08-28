import * as ort from "onnxruntime-web";

// Load the WASM runtime from a CDN (matches the installed onnxruntime-web
// version) and stay single-threaded so it works without special COOP/COEP
// headers in dev.
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/";
ort.env.wasm.numThreads = 1;

export type Prediction = { letter: string; prob: number; margin: number };

export type Fingerspeller = {
  session: ort.InferenceSession;
  labels: string[];
};

/** Load the trained model and its label list from /public. */
export async function loadFingerspell(): Promise<Fingerspeller> {
  const [session, labels] = await Promise.all([
    ort.InferenceSession.create("/asl_fingerspell.onnx", {
      executionProviders: ["wasm"],
    }),
    fetch("/labels.json").then((r) => r.json() as Promise<string[]>),
  ]);
  return { session, labels };
}

/** Run the model on one 63-length hand vector and return the top letter. */
export async function classify(
  fs: Fingerspeller,
  vector: number[],
): Promise<Prediction> {
  const input = new ort.Tensor("float32", Float32Array.from(vector), [1, 63]);
  const output = await fs.session.run({ input });
  const logits = output.logits.data as Float32Array;

  // Softmax over all classes.
  let maxVal = -Infinity;
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > maxVal) maxVal = logits[i];
  }
  let sum = 0;
  const exps = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    exps[i] = Math.exp(logits[i] - maxVal);
    sum += exps[i];
  }

  // Top two probabilities, so we can measure how clear the winner is.
  let p1 = -1;
  let p2 = -1;
  let i1 = 0;
  for (let i = 0; i < exps.length; i++) {
    const p = exps[i] / sum;
    if (p > p1) {
      p2 = p1;
      p1 = p;
      i1 = i;
    } else if (p > p2) {
      p2 = p;
    }
  }

  return { letter: fs.labels[i1] ?? "?", prob: p1, margin: p1 - p2 };
}