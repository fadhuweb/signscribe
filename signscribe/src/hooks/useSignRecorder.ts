import { useEffect, useRef, useState, type RefObject } from "react";
import {
  loadSignModel,
  frameFeature,
  resample,
  classifySequence,
  type SignModel,
  type SignPred,
} from "../lib/signs";
import type { LandmarkFrame } from "../lib/landmarks";

const SAMPLE_MS = 40; // collect a feature ~25 times a second while recording
// Drop the first/last frames of a clip: the hand raising into position and,
// for two-handed signs, dropping to press the button. Must match training.
const HEAD_TRIM = 4;
const TAIL_TRIM = 10;

/**
 * Records a short window of frames on demand, then classifies it as one sign.
 * Call start() to begin capturing, stop() to end and get the top guesses.
 */
export function useSignRecorder({
  frameRef,
}: {
  frameRef: RefObject<LandmarkFrame | null>;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [last, setLast] = useState<SignPred[] | null>(null);

  const modelRef = useRef<SignModel | null>(null);
  const bufRef = useRef<number[][]>([]);
  const timerRef = useRef<number | null>(null);
  const lastSeqRef = useRef<number[][] | null>(null); // last resampled clip, for debugging

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
    };
  }, []);

  const start = () => {
    if (!ready) return;
    bufRef.current = [];
    setLast(null);
    setRecording(true);
    timerRef.current = window.setInterval(() => {
      bufRef.current.push(frameFeature(frameRef.current));
    }, SAMPLE_MS);
  };

  const stop = async (): Promise<SignPred[] | null> => {
    setRecording(false);
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const m = modelRef.current;
    const buf = bufRef.current;
    if (!m || buf.length < 6) {
      setLast(null);
      return null;
    }
    // Trim the button-reach off the ends before recognizing.
    const clip =
      buf.length > HEAD_TRIM + TAIL_TRIM + 6
        ? buf.slice(HEAD_TRIM, buf.length - TAIL_TRIM)
        : buf;
    const seq = resample(clip);
    lastSeqRef.current = seq;
    const preds = await classifySequence(m, seq);
    setLast(preds);
    return preds;
  };

  // Debug: download the last resampled clip so we can run it through the model offline.
  const dumpLast = () => {
    if (!lastSeqRef.current) return;
    const blob = new Blob([JSON.stringify(lastSeqRef.current)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "live_clip.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return { ready, error, recording, last, start, stop, dumpLast };
}