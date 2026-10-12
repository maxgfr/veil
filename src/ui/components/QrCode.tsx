/** QR code drawn as SVG elements (no innerHTML: Trusted Types stay strict). */
import type { JSX } from "preact";
import { useMemo } from "preact/hooks";
import { encode } from "uqr";

export function QrCode(props: { value: string; label: string; size?: number }): JSX.Element {
  const path = useMemo(() => {
    const { data, size } = encode(props.value, {
      ecc: props.value.length > 600 ? "L" : "M",
      border: 2,
    });
    let d = "";
    for (let y = 0; y < size; y++) {
      const row = data[y] ?? [];
      for (let x = 0; x < size; x++) if (row[x]) d += `M${x} ${y}h1v1h-1z`;
    }
    return { d, size };
  }, [props.value]);
  return (
    <svg
      class="qr"
      viewBox={`0 0 ${path.size} ${path.size}`}
      width={props.size ?? 220}
      height={props.size ?? 220}
      role="img"
      aria-label={props.label}
      shape-rendering="crispEdges"
    >
      <rect width={path.size} height={path.size} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}
