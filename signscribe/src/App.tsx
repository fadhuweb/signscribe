import { useRef, useState } from "react";
import { useCamera } from "./hooks/useCamera";
import { useLandmarks } from "./hooks/useLandmarks";
import { useFingerspelling } from "./hooks/useFingerspelling";
import { useRecordProcess } from "./hooks/useRecordProcess";
import { useContinuousSigns } from "./hooks/useContinuousSigns";
import CapturePanel from "./CapturePanel";
import SignCapturePanel from "./SignCapturePanel";
import "./App.css";

const DEV = import.meta.env.DEV;

export default function App() {
  const { videoRef, running, error, start, stop } = useCamera();
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [mirror, setMirror] = useState(false);
  const [showOverlay, setShowOverlay] = useState(DEV);
  const [captureMode, setCaptureMode] = useState(false); // letter capture
  const [signCapture, setSignCapture] = useState(false); // sign-clip capture
  const [continuous, setContinuous] = useState(false); // continuous sentence mode
  const [transcript, setTranscript] = useState("");
  const [copied, setCopied] = useState(false);

  const inCapture = captureMode || signCapture;

  // Record-then-process: grabs raw frames while signing, tracks them afterward.
  const sign = useRecordProcess({ videoRef });

  const { ready, loadError, stats, frameRef } = useLandmarks({
    videoRef,
    overlayRef,
    // Real-time tracking only runs where it's needed: continuous mode and the
    // capture panels. In plain tap mode, record-then-process handles everything
    // after capture, so we keep the real-time tracker off to avoid the freezes.
    active: running && (continuous || inCapture),
    showOverlay,
  });

  const appendWord = (word: string) =>
    setTranscript((t) => t + (t && !t.endsWith(" ") ? " " : "") + word + " ");

  const cont = useContinuousSigns({
    frameRef,
    active: running && continuous && !inCapture,
    onWord: appendWord,
  });

  const fs = useFingerspelling({
    frameRef,
    active: running && !inCapture && !continuous && !sign.recording,
    onCommit: (letter) => setTranscript((t) => t + letter),
  });

  const statusLabel = error ? "ERROR" : running ? "LIVE" : "READY";

  const copy = async () => {
    if (!transcript.trim()) return;
    try {
      await navigator.clipboard.writeText(transcript);
    } catch {
      /* clipboard blocked */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const onSign = async () => {
    if (sign.recording) {
      const preds = await sign.stop();
      if (preds) {
        console.log(
          "[sign] " +
            preds
              .map((p) => `${p.word} ${(p.prob * 100).toFixed(0)}%`)
              .join("  |  "),
        );
        if (preds[0]) appendWord(preds[0].word);
      }
    } else {
      sign.start();
    }
  };

  return (
    <div className="wrap">
      <header className="header">
        <div className="glyph" aria-hidden="true">
          🤟
        </div>
        <div>
          <h1>SignScribe</h1>
          <p>Sign in front of the camera. It writes what you say.</p>
        </div>
      </header>

      <div className={"stage" + (mirror ? " mirror" : "")}>
        <video ref={videoRef} playsInline muted />
        <canvas ref={overlayRef} className="overlay-canvas" />

        <div className={"status" + (running ? " on" : "")}>
          <span className="dot" /> {statusLabel}
        </div>

        {DEV && running && !inCapture && (
          <div className="hud">
            {ready ? (
              <>
                {stats.fps} fps · {stats.hands} hand
                {stats.hands === 1 ? "" : "s"}
                {continuous
                  ? ` · ${cont.status}`
                  : fs.current
                    ? ` · ${fs.current.letter} ${Math.round(fs.current.prob * 100)}%`
                    : ""}
              </>
            ) : (
              "loading tracking…"
            )}
          </div>
        )}

        {running && continuous && (
          <div className="stage-note">
            {cont.hint
              ? cont.hint
              : cont.status === "signing"
                ? "reading sign…"
                : "sign continuously"}
          </div>
        )}
        {running && sign.recording && (
          <div className="stage-note">Signing… make the sign, then press Read</div>
        )}
        {running && sign.busy && <div className="stage-note">reading sign…</div>}
        {running && !ready && !loadError && !sign.recording && !continuous && (
          <div className="stage-note">Loading tracking…</div>
        )}
        {running && loadError && (
          <div className="stage-note err">A model failed to load</div>
        )}

        {!running && (
          <div className="overlay">
            {error ? (
              <p className="msg err">
                <span className="big">{error.title}</span>
                {error.detail}
              </p>
            ) : (
              <p className="msg">
                <span className="big">Camera is off</span>
                Press Start to turn on your camera.
              </p>
            )}
          </div>
        )}
      </div>

      {captureMode ? (
        <CapturePanel frameRef={frameRef} />
      ) : signCapture ? (
        <SignCapturePanel frameRef={frameRef} />
      ) : (
        <div className="transcript">
          <div className="label">
            <span>Transcript</span>
            <span className="phase-note">
              {continuous ? "phase 4 · continuous signs" : "phase 3 · signs + fingerspelling"}
            </span>
          </div>
          <div className="text">
            {transcript ? (
              transcript
            ) : (
              <span className="ph">
                {continuous
                  ? "Sign your words one after another; they appear here."
                  : "Fingerspell, or press Sign for a whole word."}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="controls">
        <button
          className={"btn primary" + (running ? " stop" : "")}
          onClick={() => (running ? stop() : start())}
        >
          <span className="ico" /> {running ? "Stop" : "Start"}
        </button>

        {running && !inCapture && !continuous && sign.ready && (
          <button
            className={"btn" + (sign.recording ? " signing" : "")}
            onClick={onSign}
            disabled={sign.busy}
          >
            {sign.busy ? "Reading…" : sign.recording ? "Read sign" : "Sign word"}
          </button>
        )}

        {!inCapture && (
          <>
            <button className="btn" onClick={copy} disabled={!transcript.trim()}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              className="btn"
              onClick={() => setTranscript("")}
              disabled={!transcript}
            >
              Clear
            </button>
          </>
        )}
        <span className="spacer" />
        {!inCapture && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={continuous}
              onChange={(e) => setContinuous(e.target.checked)}
            />
            <span className="sw" /> Continuous
          </label>
        )}
        {DEV && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={captureMode}
              onChange={(e) => {
                setCaptureMode(e.target.checked);
                if (e.target.checked) setSignCapture(false);
              }}
            />
            <span className="sw" /> Letters
          </label>
        )}
        {DEV && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={signCapture}
              onChange={(e) => {
                setSignCapture(e.target.checked);
                if (e.target.checked) setCaptureMode(false);
              }}
            />
            <span className="sw" /> Sign rec
          </label>
        )}
        {DEV && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={showOverlay}
              onChange={(e) => setShowOverlay(e.target.checked)}
            />
            <span className="sw" /> Tracking
          </label>
        )}
        <label className="toggle">
          <input
            type="checkbox"
            checked={mirror}
            onChange={(e) => setMirror(e.target.checked)}
          />
          <span className="sw" /> Mirror
        </label>
      </div>

      <p className="foot">
        <b>Phase 4.</b> Turn on Continuous, then sign your words one after another
        with a small pause between each. The app spots each sign and adds the
        word. It only knows the signs you trained, so sentences are built from
        those.
      </p>
    </div>
  );
}