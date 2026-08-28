import { useEffect, useRef, useState, type RefObject } from "react";
import {
  loadFingerspell,
  classify,
  type Fingerspeller,
  type Prediction,
} from "../lib/fingerspell";
import type { LandmarkFrame } from "../lib/landmarks";

type Options = {
  frameRef: RefObject<LandmarkFrame | null>;
  active: boolean;
  /** Called once each time a letter is committed. */
  onCommit: (letter: string) => void;
};

// Commit tuning.
const THRESHOLD = 0.85; // min confidence to consider a letter
const MARGIN = 0.2; // top guess must beat the second guess by this much
const HOLD_MS = 350; // how long a shape must stay stable to commit
const TICK_MS = 40; // how often we run the model (~25 times a second)
// J and Z are motion letters; a single-frame model cannot do them.
const EXCLUDE = new Set(["J", "Z"]);

/**
 * Reads the live hand vector from frameRef, runs the fingerspelling model, and
 * commits a letter when the same confident shape is held briefly. Breaking the
 * shape (dropping the hand or a low-confidence moment) re-arms it, so you can
 * type the same letter twice by pausing between.
 */
export function useFingerspelling({ frameRef, active, onCommit }: Options) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Prediction | null>(null);

  const fsRef = useRef<Fingerspeller | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // Commit state (kept in refs so it never triggers renders).
  const candidateRef = useRef<string | null>(null);
  const candidateSinceRef = useRef(0);
  const lastCommittedRef = useRef<string | null>(null);
  const armedRef = useRef(true);
  const lastCurrentPushRef = useRef(0);

  // Load the model once.
  useEffect(() => {
    let cancelled = false;
    loadFingerspell()
      .then((fs) => {
        if (!cancelled) {
          fsRef.current = fs;
          setReady(true);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Inference + commit loop.
  useEffect(() => {
    if (!active || !ready) return;
    const fs = fsRef.current;
    if (!fs) return;

    let stopped = false;
    let busy = false;

    const tick = async () => {
      if (stopped) return;
      const frame = frameRef.current;
      const hand = frame?.hands?.[0];

      if (!hand) {
        candidateRef.current = null;
        armedRef.current = true; // a gap re-arms same-letter repeats
        pushCurrent(null);
      } else if (!busy) {
        busy = true;
        try {
          const pred = await classify(fs, hand.vector);
          pushCurrent(pred);
          const now = performance.now();

          if (
            pred.prob < THRESHOLD ||
            pred.margin < MARGIN ||
            EXCLUDE.has(pred.letter)
          ) {
            candidateRef.current = null;
            armedRef.current = true;
          } else if (pred.letter !== candidateRef.current) {
            candidateRef.current = pred.letter;
            candidateSinceRef.current = now;
          } else if (now - candidateSinceRef.current >= HOLD_MS) {
            const isRepeat = pred.letter === lastCommittedRef.current;
            if (armedRef.current || !isRepeat) {
              onCommitRef.current(pred.letter);
              lastCommittedRef.current = pred.letter;
              armedRef.current = false;
              candidateRef.current = null; // require a fresh hold
            }
          }
        } catch {
          /* one dropped frame is fine */
        } finally {
          busy = false;
        }
      }

      if (!stopped) setTimeout(tick, TICK_MS);
    };

    // Throttle the on-screen prediction to a few updates a second.
    function pushCurrent(pred: Prediction | null) {
      const now = performance.now();
      if (now - lastCurrentPushRef.current >= 150) {
        lastCurrentPushRef.current = now;
        setCurrent(pred);
      }
    }

    setTimeout(tick, TICK_MS);
    return () => {
      stopped = true;
    };
  }, [active, ready, frameRef]);

  return { ready, error, current };
}