/** One outline icon set (24px grid, 1.75 stroke, currentColor). States come from CSS. */
import type { JSX } from "preact";

const PATHS = {
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M19 11a7 7 0 0 1-14 0 M12 18v3",
  micOff:
    "M3 3l18 18 M9 9v3a3 3 0 0 0 5.1 2.1 M15 9.3V6a3 3 0 0 0-5.7-1.3 M19 11a7 7 0 0 1-.9 3.4 M5 11a7 7 0 0 0 11 5.7 M12 18v3",
  cam: "M15 10l5-3v10l-5-3 M3 7h12v10H3z",
  camOff: "M3 3l18 18 M15 10l5-3v10l-2-1.2 M11 7h4v4 M3 7h2 M3 7v10h12v-2",
  screen: "M3 4h18v12H3z M8 20h8 M12 16v4 M9 10l3-3 3 3 M12 7v6",
  leave: "M10 17l-5-5 5-5 M5 12h11 M14 4h5v16h-5",
  chat: "M4 5h16v11H9l-5 4z",
  attach:
    "M20 12l-8.5 8.5a5 5 0 0 1-7-7L13 5a3.3 3.3 0 0 1 4.7 4.7L9.2 18.2a1.7 1.7 0 0 1-2.4-2.4L15 7.6",
  send: "M4 12l16-8-6 16-2.5-6.5z M11.5 13.5L20 4",
  share: "M12 3v12 M7 8l5-5 5 5 M5 13v7h14v-7",
  qr: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h2v2h-2z M18 14h2 M14 18h2 M18 18h2v2",
  scan: "M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M4 12h16",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z M8.5 12l2.5 2.5 4.5-5",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2 1.2L14.8 21h-4l-.3-2.4a7 7 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-2.4L4.6 9.9l2-3.4 1.9.7a7 7 0 0 1 2-1.2L10.8 3h4l.3 2.4a7 7 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.4z",
  users:
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21a7 7 0 0 1 14 0 M16 3.5a4 4 0 0 1 0 7.5 M22 21a7 7 0 0 0-4-6.3",
  x: "M6 6l12 12 M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7",
  copy: "M9 9h11v11H9z M5 15H4V4h11v1",
  download: "M12 4v12 M7 11l5 5 5-5 M5 20h14",
  file: "M14 3H6v18h12V7z M14 3v4h4",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  plus: "M12 5v14 M5 12h14",
  lock: "M6 11h12v10H6z M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
  arrowLeft: "M19 12H5 M11 6l-6 6 6 6",
  alert: "M12 4l9 16H3z M12 10v4 M12 17h.01",
  wifi: "M2 9a15 15 0 0 1 20 0 M5.5 12.5a10 10 0 0 1 13 0 M9 16a5 5 0 0 1 6 0 M12 19.5h.01",
  hand: "M12 12h.01",
  record: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  sparkle:
    "M10 4l1.6 4.4L16 10l-4.4 1.6L10 16l-1.6-4.4L4 10l4.4-1.6z M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z",
  captions: "M3 5h18v14H3z M10.5 10a2.5 2.5 0 1 0 0 4 M17 10a2.5 2.5 0 1 0 0 4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: {
  name: IconName;
  size?: number;
  class?: string;
  label?: string;
}): JSX.Element {
  const size = props.size ?? 20;
  return (
    <svg
      class={props.class ? `icon ${props.class}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.label ? undefined : "true"}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      focusable="false"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}

/** The Veil mark: two overlapping arcs, a veil over a circle. */
export function Logo(props: { size?: number }): JSX.Element {
  const s = props.size ?? 32;
  return (
    <svg class="logo" width={s} height={s} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <circle
        cx="16"
        cy="17.5"
        r="6.5"
        fill="none"
        stroke="var(--on-accent)"
        stroke-width="2"
        opacity="0.55"
      />
      <path
        d="M7 14.5c3.2-5 14.8-5 18 0"
        fill="none"
        stroke="var(--on-accent)"
        stroke-width="2.2"
        stroke-linecap="round"
      />
    </svg>
  );
}
