import { useCallback, useEffect, useRef, useState } from "react";

export type CameraError = { title: string; detail: string };

/**
 * Owns the webcam lifecycle: request the stream, attach it to a <video>,
 * release it on stop or unmount, and turn getUserMedia failures into
 * plain-language messages. Phase 1 will read frames off videoRef.
 */
export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<CameraError | null>(null);

  const stop = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setRunning(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError({
        title: "Camera not available",
        detail:
          "This browser will not grant camera access here. Open the app over https or on localhost.",
      });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {
          /* autoplay is allowed because the element is muted */
        });
      }
      setRunning(true);
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError({
          title: "Camera permission denied",
          detail: "Allow camera access in your browser, then press Start again.",
        });
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError({
          title: "No camera found",
          detail: "Connect a webcam and press Start again.",
        });
      } else if (name === "NotReadableError") {
        setError({
          title: "Camera is busy",
          detail: "Another app is using the camera. Close it and press Start again.",
        });
      } else {
        setError({
          title: "Could not start the camera",
          detail: "Something went wrong reaching the camera. Try again.",
        });
      }
      stop();
    }
  }, [stop]);

  // Release the camera when the component unmounts.
  useEffect(() => stop, [stop]);

  return { videoRef, running, error, start, stop };
}