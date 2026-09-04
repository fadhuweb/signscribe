import { useEffect, useRef, useState, type RefObject } from "react";
import {
  createTrackers,
  handVector,
  HandLandmarker,
  PoseLandmarker,
  DrawingUtils,
  type LandmarkFrame,
  type Trackers,
} from "../lib/landmarks";

type Options = {
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayRef: RefObject<HTMLCanvasElement | null>;
  /** Run the detection loop (camera on). */
  active: boolean;
  /** Draw the tracking overlay. Dev aid only. */
  showOverlay: boolean;
};

export type TrackStats = { fps: number; hands: number; pose: boolean };

/**
 * Runs hand and pose detection on the video every frame while `active`.
 * Keeps the newest result in `frameRef` for later phases to read, and can
 * draw a dev overlay onto `overlayRef`. It never triggers a React render per
 * frame; only the throttled `stats` update the UI.
 */
export function useLandmarks({ videoRef, overlayRef, active, showOverlay }: Options) {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stats, setStats] = useState<TrackStats>({ fps: 0, hands: 0, pose: false });

  const trackersRef = useRef<Trackers | null>(null);
  const frameRef = useRef<LandmarkFrame | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);
  const drawRef = useRef<DrawingUtils | null>(null);

  // Load the models once.
  useEffect(() => {
    let cancelled = false;
    createTrackers()
      .then((t) => {
        if (cancelled) {
          t.hand.close();
          t.pose.close();
          return;
        }
        trackersRef.current = t;
        setReady(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
      const t = trackersRef.current;
      if (t) {
        t.hand.close();
        t.pose.close();
        trackersRef.current = null;
      }
    };
  }, []);

  // The detection loop.
  useEffect(() => {
    if (!active || !ready) return;
    const trackers = trackersRef.current;
    if (!trackers) return;

    let frames = 0;
    let fpsClock = performance.now();

    // Pose is the expensive detector and only feeds shoulder position, which
    // moves slowly. Run it every few frames and reuse the last result. Hands run
    // every frame. This roughly doubles the frame rate on a slow machine.
    const POSE_EVERY = 3;
    let poseTick = 0;
    let lastPose: LandmarkFrame["pose"] = null;

    const loop = () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      // detectForVideo needs strictly increasing timestamps.
      let ts = performance.now();
      if (ts <= lastTsRef.current) ts = lastTsRef.current + 1;
      lastTsRef.current = ts;

      const handRes = trackers.hand.detectForVideo(v, ts);
      poseTick++;
      if (poseTick % POSE_EVERY === 0) {
        const poseRes = trackers.pose.detectForVideo(v, ts);
        lastPose = poseRes.landmarks?.[0] ?? null;
      }

      const hands = (handRes.landmarks ?? []).map((lm, i) => {
        const cat = handRes.handedness?.[i]?.[0];
        return {
          handedness: (cat?.categoryName === "Left" ? "Left" : "Right") as
            | "Left"
            | "Right",
          score: cat?.score ?? 0,
          landmarks: lm,
          vector: handVector(lm),
        };
      });
      const pose = lastPose;

      // This is the stream later phases consume.
      frameRef.current = { timestamp: ts, hands, pose };

      // Dev overlay.
      const canvas = overlayRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          if (showOverlay) {
            if (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight) {
              canvas.width = v.videoWidth;
              canvas.height = v.videoHeight;
            }
            if (!drawRef.current) drawRef.current = new DrawingUtils(ctx);
            const draw = drawRef.current;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (pose) {
              draw.drawConnectors(pose, PoseLandmarker.POSE_CONNECTIONS, {
                color: "rgba(77,212,255,0.45)",
                lineWidth: 2,
              });
            }
            for (const lm of handRes.landmarks ?? []) {
              draw.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, {
                color: "#4dd4ff",
                lineWidth: 3,
              });
              draw.drawLandmarks(lm, { color: "#c4edff", radius: 3 });
            }
          } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
        }
      }

      // Throttled stats for the HUD (about 4 times a second).
      frames++;
      const now = performance.now();
      if (now - fpsClock >= 250) {
        setStats({
          fps: Math.round((frames * 1000) / (now - fpsClock)),
          hands: hands.length,
          pose: !!pose,
        });
        frames = 0;
        fpsClock = now;
      }

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      const c = overlayRef.current;
      const ctx = c?.getContext("2d");
      if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    };
  }, [active, ready, showOverlay, videoRef, overlayRef]);

  return { ready, loadError, stats, frameRef };
}