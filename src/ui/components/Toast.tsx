import type { Signal } from "@preact/signals";
import type { JSX } from "preact";
import type { Toast as ToastItem } from "../session";
import { Icon } from "./Icons";

export function Toasts(props: { toasts: Signal<ToastItem[]> }): JSX.Element {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {props.toasts.value.map((t) => (
        <div key={t.id} class={`toast toast-${t.tone}`}>
          {t.tone !== "info" && <Icon name="alert" size={18} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
