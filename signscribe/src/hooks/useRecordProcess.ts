import { useEffect, useRef, useState, type RefObject } from "react";
import {
  createTrackers,
  handVector,
  type LandmarkFrame,
} from "../lib/landmarks";
import {
  loadSignModel,
  frameFeature,
  resample,
  classifySequence,
  type SignModel,
  type SignPred,
} from "../lib/signs";

// While recording, grab raw camera frames cheaply, with no tracking. After you
// stop, spin up a FRESH tracker and run it over the saved frames in order, in
// VIDEO mode, so it tracks your hand across the clip with no stale state from a
// previous sign, and off the real-time clock so a slow machine isn't rushed.
const GRAB_MS = 55; // grab a frame ~18 times a second (cheap: no detection)
const RESIZE_W = 640; // keep near full size so the hand detector can find hands
const MAX_FRAMES = 64; // hard cap for a very long hold

export function useRecordProcess({
  videoRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false); // processing the clip after stop

  const modelRef = useRef<SignModel | null>(null);
  const framesRef = useRef<ImageBitmap[]>([]);
  const timerRef = useRef<number | null>(null);
  const grabbingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadSignModel()
      .then((m) => {
        if (!cancelled) {
          modelRef.current = m;
          setReady(true);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      if (timerRef.current != null) clearInterval(timerRef.current);
      framesRef.current.forEach((b) => b.close());
      framesRef.current = [];
    };
  }, []);

  const start = () => {
    if (!ready) return;
    framesRef.current.forEach((b) => b.close());
    framesRef.current = [];
    setRecording(true);
    timerRef.current = window.setInterval(async () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || grabbingRef.current) return;
      grabbingRef.current = true;
      try {
        const h = Math.round(RESIZE_W * (v.videoHeight / v.videoWidth || 0.75));
        const bmp = await createImageBitmap(v, {
          resizeWidth: RESIZE_W,
          resizeHeight: h,
        });
        framesRef.current.push(bmp);
      } catch {
        /* skip a frame that failed to grab */
      }
      grabbingRef.current = false;
    }, GRAB_MS);
  };

  const stop = async (): Promise<SignPred[] | null> => {
    setRecording(false);
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const m = modelRef.current;
    let frames = framesRef.current;
    framesRef.current = [];
    if (!m || frames.length < 4) {
      frames.forEach((b) => b.close());
      return null;
    }

    // Keep the frames consecutive so VIDEO-mode tracking works; if a hold is very
    // long, keep the most recent ones.
    if (frames.length > MAX_FRAMES) {
      const drop = frames.slice(0, frames.length - MAX_FRAMES);
      drop.forEach((b) => b.close());
      frames = frames.slice(frames.length - MAX_FRAMES);
    }

    setBusy(true);
    // Fresh tracker every time: no state carried over from the previous sign.
    const t = await createTrackers();
    const seq: number[][] = [];
    try {
      let ts = 0;
      for (const bmp of frames) {
        ts += 40; // strictly increasing
        const hres = t.hand.detectForVideo(bmp, ts);
        const pres = t.pose.detectForVideo(bmp, ts);
        const hands = (hres.landmarks ?? []).map((lm, i) => ({
          handedness: (hres.handedness?.[i]?.[0]?.categoryName === "Left"
            ? "Left"
            : "Right") as "Left" | "Right",
          score: hres.handedness?.[i]?.[0]?.score ?? 0,
          landmarks: lm,
          vector: handVector(lm),
        }));
        const pose = pres.landmarks?.[0] ?? null;
        const frame: LandmarkFrame = { timestamp: ts, hands, pose };
        seq.push(frameFeature(frame));
        bmp.close();
        // yield so the UI can paint the "reading" state
        await new Promise((r) => setTimeout(r, 0));
      }
      const withHand = seq.filter((f) => f[0] > 0.5 || f[67] > 0.5).length;
      console.log(`[rp] frames=${seq.length} withHand=${withHand}`);
      const preds = await classifySequence(m, resample(seq));
      return preds;
    } finally {
      t.hand.close();
      t.pose.close();
      setBusy(false);
    }
  };

  return { ready, error, recording, busy, start, stop };
}