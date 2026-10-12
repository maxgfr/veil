import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Sas } from "../../crypto/sas";
import type { RoomSession } from "../session";
import { Sheet } from "./Sheet";

export function VerifySheet(props: {
  peerId: string | null;
  session: RoomSession;
  onClose: () => void;
}): JSX.Element {
  const [sas, setSas] = useState<Sas | null>(null);
  const id = props.peerId;
  useEffect(() => {
    setSas(null);
    if (id) void props.session.sas(id).then(setSas);
  }, [id]);
  const nick = id ? props.session.nickOf(id) : "";
  return (
    <Sheet open={!!id} onClose={props.onClose} title={`Verify ${nick}`} testid="verify-sheet">
      {!sas ? (
        <p class="muted">
          You need a direct connection with {nick} to verify. Try again in a moment.
        </p>
      ) : (
        <div class="stack">
          <p class="muted">
            Compare these four emojis with {nick}, out loud or on a call. If they match, nobody sits
            in the middle of your connection, not even someone holding the room link.
          </p>
          <ol class="sas" data-testid="sas">
            {sas.emojis.map((e, i) => (
              <li key={`${e}-${i}`}>
                <span class="sas-emoji" aria-hidden="true">
                  {e}
                </span>
                <span class="sas-name">{sas.names[i]}</span>
              </li>
            ))}
          </ol>
          <div class="row row-end">
            <button
              type="button"
              class="btn btn-danger-ghost"
              onClick={() => {
                if (id) props.session.markVerified(id, false);
                props.onClose();
              }}
            >
              They don't match
            </button>
            <button
              type="button"
              class="btn btn-primary"
              onClick={() => {
                if (id) props.session.markVerified(id, true);
                props.onClose();
              }}
            >
              They match
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
