import { useEffect, useRef, useState, type RefObject } from "react";
import type { LandmarkFrame } from "./lib/landmarks";

// J and Z are motion letters, so we don't capture static samples for them.
const LETTERS = "ABCDEFGHIKLMNOPQRSTUVWXY".split(""); // 24 static letters

const SAMPLE_MS = 50; // capture one sample every 50ms while recording
const TARGET = 150; // suggested samples per letter

type Store = Record<string, number[][]>;

export default function CapturePanel({
  frameRef,
}: {
  frameRef: RefObject<LandmarkFrame | null>;
}) {
  const [letter, setLetter] = useState("A");
  const [recording, setRecording] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [handSeen, setHandSeen] = useState(false);

  const storeRef = useRef<Store>({});

  // Recording loop: while on, append the current hand vector to the letter.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const hand = frameRef.current?.hands?.[0];
      setHandSeen(!!hand);
      if (!hand) return;
      const arr = storeRef.current[letter] ?? (storeRef.current[letter] = []);
      arr.push(hand.vector);
      setCounts((c) => ({ ...c, [letter]: arr.length }));
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [recording, letter, frameRef]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const clearLetter = () => {
    delete storeRef.current[letter];
    setCounts((c) => ({ ...c, [letter]: 0 }));
  };

  const clearAll = () => {
    storeRef.current = {};
    setCounts({});
  };

  const exportData = () => {
    const blob = new Blob([JSON.stringify(storeRef.current)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "my_samples.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="capture">
      <div className="cap-head">
        <div>
          <div className="cap-title">Capture your samples</div>
          <div className="cap-sub">
            Pick a letter, make the shape, then click Record and wiggle your hand a
            little. Click again to stop. Aim for {TARGET}+ each. Focus on the ones
            it gets wrong.
          </div>
        </div>
        <div className="cap-total">{total} total</div>
      </div>

      <div className="cap-letters">
        {LETTERS.map((L) => {
          const n = counts[L] ?? 0;
          const enough = n >= TARGET;
          return (
            <button
              key={L}
              className={
                "cap-chip" +
                (L === letter ? " active" : "") +
                (enough ? " enough" : n > 0 ? " some" : "")
              }
              onClick={() => setLetter(L)}
            >
              {L}
              <span className="cap-n">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="cap-controls">
        <button
          className={"btn primary cap-rec" + (recording ? " on" : "")}
          onClick={() => setRecording((r) => !r)}
        >
          {recording ? `Stop recording ${letter}` : `Record ${letter}`}
        </button>
        <button className="btn" onClick={clearLetter}>
          Clear {letter}
        </button>
        <button className="btn" onClick={clearAll}>
          Clear all
        </button>
        <span className="spacer" />
        <button className="btn" onClick={exportData} disabled={total === 0}>
          Export my_samples.json
        </button>
      </div>

      {recording && !handSeen && (
        <div className="cap-warn">No hand detected. Move into frame.</div>
      )}
    </div>
  );
}