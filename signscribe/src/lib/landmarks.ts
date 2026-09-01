import {
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
  DrawingUtils,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

// The WASM version must match the installed @mediapipe/tasks-vision version.
const WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export type Hand = {
  handedness: "Left" | "Right";
  score: number;
  /** 21 raw normalized landmarks, straight from MediaPipe (0..1 image space). */
  landmarks: NormalizedLandmark[];
  /** 63 numbers: wrist-centered and scaled by hand size, so camera distance and position cancel. */
  vector: number[];
};

export type LandmarkFrame = {
  timestamp: number;
  hands: Hand[];
  /** 33 raw normalized pose landmarks, or null when no body is found. */
  pose: NormalizedLandmark[] | null;
};

export type Trackers = {
  hand: HandLandmarker;
  pose: PoseLandmarker;
};

/** Load the hand and pose models. Downloads WASM and the .task files on first call. */
export async function createTrackers(): Promise<Trackers> {
  const vision = await FilesetResolver.forVisionTasks(WASM);
  const hand = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 2,
    // Low thresholds so the tracker holds a fist or a hand against the body
    // instead of dropping it.
    minHandDetectionConfidence: 0.3,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  });
  const pose = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  return { hand, pose };
}

/**
 * Turn one hand's 21 landmarks into a 63-length vector that does not depend on
 * where the hand is in the frame or how far it is from the camera. Recenter on
 * the wrist, then scale by the wrist-to-middle-knuckle distance.
 */
export function handVector(lm: NormalizedLandmark[]): number[] {
  const wrist = lm[0];
  const cz = wrist.z ?? 0;
  const mid = lm[9]; // middle-finger knuckle (MCP)
  const scale =
    Math.hypot(mid.x - wrist.x, mid.y - wrist.y, (mid.z ?? 0) - cz) || 1e-6;

  const out: number[] = [];
  for (const p of lm) {
    out.push(
      (p.x - wrist.x) / scale,
      (p.y - wrist.y) / scale,
      ((p.z ?? 0) - cz) / scale,
    );
  }
  return out;
}

export { HandLandmarker, PoseLandmarker, DrawingUtils };