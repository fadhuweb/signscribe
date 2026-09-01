import { useEffect, useRef, useState, type RefObject } from "react";
import type { LandmarkFrame } from "./lib/landmarks";
import { frameFeature } from "./lib/signs";

const WORDS = [
  "HELLO", "GOODBYE", "THANK YOU", "YOU'RE WELCOME", "PLEASE", "SORRY", "YES",
  "NO", "ME", "YOU", "NAME", "HELP", "WANT", "MORE", "FINISH", "EAT", "DRINK",
  "GOOD", "HAPPY", "LOVE", "FRIEND", "HOME", "MORNING", "NIGHT",
];

const SAMPLE_MS = 40; // ~25 features a second, matches inference
const TARGET = 25; // suggested takes per word

// word -> takes -> frames -> 134 features
type Store = Record<string, number[][][]>;

export default function SignCapturePanel({
  frameRef,
}: {
  frameRef: RefObject<LandmarkFrame | null>;
}) {
  const [word, setWord] = useState(WORDS[0]);
  const [recording, setRecording] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [frames, setFrames] = useState(0);

  const storeRef = useRef<Store>({});
  const bufRef = useRef<number[][]>([]);
  const timerRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearInterval(timerRef.current);
    };
  }, []);

  const refreshCounts = () => {
    const c: Record<string, number> = {};
    for (const [w, takes] of Object.entries(storeRef.current)) c[w] = takes.length;
    setCounts(c);
  };

  const startTake = () => {
    bufRef.current = [];
    setFrames(0);
    setRecording(true);
    timerRef.current = window.setInterval(() => {
      bufRef.current.push(frameFeature(frameRef.current));
      setFrames(bufRef.current.length);
    }, SAMPLE_MS);
  };

  const stopTake = () => {
    setRecording(false);
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const buf = bufRef.current;
    if (buf.length >= 6) {
      const arr = storeRef.current[word] ?? (storeRef.current[word] = []);
      arr.push(buf);
      setCounts((c) => ({ ...c, [word]: arr.length }));
    }
    bufRef.current = [];
    setFrames(0);
  };

  const undoLast = () => {
    const arr = storeRef.current[word];
    if (arr && arr.length) {
      arr.pop();
      setCounts((c) => ({ ...c, [word]: arr.length }));
    }
  };

  const clearAll = () => {
    storeRef.current = {};
    setCounts({});
  };

  // Merge a previously exported file back in, so you can continue after a reload.
  const importData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result)) as Store;
        for (const [w, takes] of Object.entries(obj)) {
          const arr = storeRef.current[w] ?? (storeRef.current[w] = []);
          for (const t of takes) arr.push(t);
        }
        refreshCounts();
      } catch {
        /* ignore a bad file */
      }
    };
    reader.readAsText(f);
    e.target.value = "";
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const exportData = () => {
    const blob = new Blob([JSON.stringify(storeRef.current)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sign_samples.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="capture">
      <div className="cap-head">
        <div>
          <div className="cap-title">Record your signs</div>
          <div className="cap-sub">
            Pick a word, press Record take, perform the sign once, press Stop.
            One take per press. Aim for {TARGET}+ takes each. After a reload, use
            Import to load your saved file and keep going.
          </div>
        </div>
        <div className="cap-total">{total} takes</div>
      </div>

      <div className="cap-letters words">
        {WORDS.map((w) => {
          const n = counts[w] ?? 0;
          const enough = n >= TARGET;
          return (
            <button
              key={w}
              className={
                "cap-chip word" +
                (w === word ? " active" : "") +
                (enough ? " enough" : n > 0 ? " some" : "")
              }
              onClick={() => !recording && setWord(w)}
            >
              <span>{w}</span>
              <span className="cap-n">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="cap-controls">
        <button
          className={"btn primary cap-rec" + (recording ? " on" : "")}
          onClick={() => (recording ? stopTake() : startTake())}
        >
          {recording ? `Stop take (${frames} frames)` : `Record take · ${word}`}
        </button>
        <button className="btn" onClick={undoLast} disabled={!(counts[word] > 0)}>
          Undo last {word}
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          Import samples
        </button>
        <button className="btn" onClick={clearAll}>
          Clear all
        </button>
        <span className="spacer" />
        <button className="btn" onClick={exportData} disabled={total === 0}>
          Export sign_samples.json
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          onChange={importData}
          style={{ display: "none" }}
        />
      </div>
    </div>
  );
}