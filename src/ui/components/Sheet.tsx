/**
 * Modal sheet on the native <dialog>: focus trap, Escape and inert background
 * come from the platform. Bottom sheet on phones, centered panel on desktop.
 */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "./Icons";

export function Sheet(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
  testid?: string;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    else if (!props.open && d.open) d.close();
  }, [props.open]);
  // A click on the backdrop lands on the <dialog> itself: close (Escape is handled natively).
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    const d = ref.current;
    const onClick = (e: MouseEvent) => {
      if (e.target === d) onClose.current();
    };
    d?.addEventListener("click", onClick);
    return () => d?.removeEventListener("click", onClick);
  }, []);
  return (
    <dialog
      ref={ref}
      class={props.wide ? "sheet sheet-wide" : "sheet"}
      aria-label={props.title}
      data-testid={props.testid}
      onClose={() => props.open && props.onClose()}
    >
      {props.open && (
        <div class="sheet-body">
          <header class="sheet-head">
            <h2>{props.title}</h2>
            <button type="button" class="icon-btn" onClick={props.onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </header>
          {props.children}
        </div>
      )}
    </dialog>
  );
}
