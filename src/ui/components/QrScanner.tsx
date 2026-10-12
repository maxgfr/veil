/**
 * Camera QR scanner. Uses the native BarcodeDetector when present, else
 * jsQR (loaded lazily, only when the scanner opens).
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

type DetectorCtor = new (opts: { formats: string[] }) => Detector;

export function QrScanner(props: {
  onResult: (text: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
      } catch {
        setError("Camera unavailable. Paste the link or code instead.");
        return;
      }
      if (stopped || !video.current) return;
      video.current.srcObject = stream;
      await video.current.play().catch(() => {});
      const Native = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
      const detector = Native ? new Native({ formats: ["qr_code"] }) : null;
      const jsQR = detector ? null : (await import("jsqr")).default;
      const scan = async () => {
        const v = video.current;
        if (stopped || !v) return;
        let text: string | null = null;
        if (v.videoWidth > 0) {
          if (detector) {
            text = (await detector.detect(v).catch(() => []))[0]?.rawValue ?? null;
          } else if (jsQR && ctx) {
            const w = Math.min(640, v.videoWidth);
            const h = Math.round((v.videoHeight / v.videoWidth) * w);
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(v, 0, 0, w, h);
            text =
              jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })
                ?.data ?? null;
          }
        }
        if (text && !stopped) {
          props.onResult(text);
          return;
        }
        timer = setTimeout(scan, 120);
      };
      void scan();
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const t of stream?.getTracks() ?? []) t.stop();
    };
  }, []);

  return (
    <div class="scanner">
      {error ? (
        <p class="muted">{error}</p>
      ) : (
        <div class="scanner-frame">
          <video ref={video} playsInline muted aria-label="Camera preview for QR scanning" />
          <div class="scanner-reticle" aria-hidden="true" />
        </div>
      )}
      <button type="button" class="btn btn-ghost" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  );
}
