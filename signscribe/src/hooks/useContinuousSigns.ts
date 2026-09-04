import { useEffect, useRef, useState, type RefObject } from "react";
import {
  loadSignModel,
  frameFeature,
  resample,
  classifySequence,
  type SignModel,
} from "../lib/signs";
import type { LandmarkFrame } from "../lib/landmarks";

// Motion-triggered capture, driven by real frames and tolerant of tracking
// dropouts. This is the manual "Sign word" recognizer with the button replaced
// by your hands: motion starts a clip, a real pause ends it, the whole clip is
// classified once. It reads only new tracking frames, measures time in real ms,
// and does NOT end a clip just because the hand tracker briefly loses your hand.
const POLL_MS = 25; // how often to check for a new frame
const SMOOTH = 2; // frames of motion averaging (kept low for low fps)
const START_MOVE = 0.02; // hand-shape motion that starts a clip
const STOP_MOVE = 0.012; // motion below this counts as quiet (hysteresis)
const PAUSE_MS = 320; // hand present but still this long ends a clip
const ABSENT_MS = 900; // hand gone this long ends a clip; shorter dropouts bridge
const MIN_FRAMES = 12; // shortest clip worth classifying, after trailing trim
const MAX_MS = 4000; // force-end a very long clip
const COOLDOWN_MS = 400; // ignore motion right after a commit, stops re-triggers
const CONF_THRESH = 0.6; // a clean clip is usually confident; below this, ask again
const MARGIN = 0.2; // top guess must beat the runner-up by this much

/**
 * Continuous sign recognition by motion-triggered capture. A short poll watches
 * for new tracking frames. When your hands start moving it opens a clip, keeps it
 * through brief mid-sign dips and tracking dropouts, and closes it on a real
 * pause, then classifies that one clip like the manual button.
 */
export function useContinuousSigns({
  frameRef,
  active,
  onWord,
}: {
  frameRef: RefObject<LandmarkFrame | null>;
  active: boolean;
  onWord: (word: string, prob: number) => void;
}) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "signing">("idle");
  const [hint, setHint] = useState<string | null>(null); // transient on-screen feedback

  const modelRef = useRef<SignModel | null>(null);
  const onWordRef = useRef(onWord);
  onWordRef.current = onWord;
  const hintTimer = useRef<number | null>(null);

  const flash = (msg: string) => {
    setHint(msg);
    if (hintTimer.current != null) clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), 1400);
  };

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
    };
  }, []);

  useEffect(() => {
    if (!active || !ready) return;
    const m = modelRef.current;
    if (!m) return;

    let capturing = false;
    let buf: number[][] = [];
    let prevFeat: number[] | null = null;
    let stillMs = 0; // hand present but not moving
    let absentMs = 0; // hand not detected
    let trailCount = 0; // trailing non-moving frames, trimmed off the end
    let cooldownMs = 0;
    let captureStartTs = 0;
    let lastTs = 0; // timestamp of the last frame we processed
    let diagAccum = 0; // ms since last diagnostic print
    const motionHist: number[] = [];
    let chain: Promise<void> = Promise.resolve();

    const hasHand = (f: number[]) => f[0] > 0.5 || f[67] > 0.5;

    // Mean per-coordinate change of the hand-shape feature, over hands present in
    // both frames. Captures finger and rotation movement, not just wrist travel.
    const featMotion = (a: number[], b: number[]): number => {
      let sum = 0;
      let n = 0;
      for (const base of [0, 67]) {
        if (a[base] > 0.5 && b[base] > 0.5) {
          for (let i = base + 1; i < base + 67; i++) {
            sum += Math.abs(a[i] - b[i]);
            n++;
          }
        }
      }
      return n > 0 ? sum / n : 0;
    };

    const id = window.setInterval(() => {
      const frame = frameRef.current;
      if (!frame) return;
      if (frame.timestamp === lastTs) return; // stale frame, skip
      const dt = lastTs === 0 ? POLL_MS : Math.min(frame.timestamp - lastTs, 200);
      lastTs = frame.timestamp;

      const feat = frameFeature(frame);
      const present = hasHand(feat);
      // Only measure motion between two frames that both have a hand.
      const d = present && prevFeat != null && hasHand(prevFeat)
        ? featMotion(feat, prevFeat)
        : 0;
      prevFeat = feat;
      motionHist.push(d);
      if (motionHist.length > SMOOTH) motionHist.shift();
      const motion = motionHist.reduce((a, b) => a + b, 0) / motionHist.length;

      diagAccum += dt;
      if (diagAccum >= 600) {
        diagAccum = 0;
        console.log(
          `[diag] motion=${motion.toFixed(3)} present=${present} capturing=${capturing} still=${stillMs.toFixed(0)} absent=${absentMs.toFixed(0)} buf=${buf.length}`,
        );
      }

      if (!capturing) {
        setStatus("idle");
        if (cooldownMs > 0) {
          cooldownMs -= dt;
        } else if (present && motion > START_MOVE) {
          capturing = true;
          buf = [feat];
          stillMs = 0;
          absentMs = 0;
          trailCount = 0;
          captureStartTs = frame.timestamp;
          setStatus("signing");
          console.log(`[cap] start motion=${motion.toFixed(3)}`);
        }
        return;
      }

      // Capturing. Keep every frame, dropouts included, so the clip matches how
      // the manual button and the training clips were recorded.
      buf.push(feat);
      const moving = present && motion > STOP_MOVE;
      if (moving) {
        stillMs = 0;
        absentMs = 0;
        trailCount = 0;
      } else if (present) {
        // Hand visible but still: this is how a real sign ends.
        stillMs += dt;
        absentMs = 0;
        trailCount++;
      } else {
        // Hand not detected: a dropout. Do not count it as a pause unless it
        // lasts a long time, which means the hand really left.
        absentMs += dt;
        trailCount++;
      }

      if (
        stillMs >= PAUSE_MS ||
        absentMs >= ABSENT_MS ||
        frame.timestamp - captureStartTs > MAX_MS
      ) {
        const clip = buf.slice(0, Math.max(1, buf.length - trailCount));
        capturing = false;
        buf = [];
        stillMs = 0;
        absentMs = 0;
        trailCount = 0;
        cooldownMs = COOLDOWN_MS;
        setStatus("idle");

        if (clip.length >= MIN_FRAMES) {
          const seq = resample(clip);
          const frames = clip.length;
          chain = chain.then(async () => {
            try {
              const preds = await classifySequence(m, seq);
              const top = preds[0];
              if (!top) return;
              const margin = top.prob - (preds[1]?.prob ?? 0);
              console.log(
                `[cont] frames=${frames} ${preds
                  .map((p) => `${p.word} ${(p.prob * 100).toFixed(0)}%`)
                  .join("  |  ")}`,
              );
              if (top.prob >= CONF_THRESH && margin >= MARGIN) {
                onWordRef.current(top.word, top.prob);
                flash("✓ " + top.word);
              } else {
                flash("not sure — " + top.word + "?");
              }
            } catch {
              /* one dropped classification is fine */
            }
          });
        } else {
          console.log(`[cont] clip too short: ${clip.length}f`);
        }
      }
    }, POLL_MS);

    return () => {
      clearInterval(id);
      setStatus("idle");
      if (hintTimer.current != null) clearTimeout(hintTimer.current);
      setHint(null);
    };
  }, [active, ready, frameRef]);

  return { ready, error, status, hint };
}