/**
 * What the room's connection looks like: the browser's network, each peer
 * link and each rendezvous relay.
 */
import type { JSX } from "preact";
import type { TransportState } from "../../signal/types";
import { type ConnectionSummary, LINK_LABEL, transportLabel } from "../connection";
import type { MemberView, RoomSession } from "../session";
import { Sheet } from "./Sheet";

function stateTone(state: TransportState): string {
  return state === "online" ? "ok" : state === "connecting" ? "wait" : "bad";
}

function peerMeta(m: MemberView): string {
  if (m.blocked) return "Verification failed";
  if (!m.link) return "Reached through the mesh";
  if (m.link !== "connected") return LINK_LABEL[m.link] ?? m.link;
  const path = m.relayed ? "TURN" : "Direct";
  return m.rtt !== null ? `${path} · ${m.rtt} ms` : path;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function ConnectionSheet(props: {
  open: boolean;
  onClose: () => void;
  session: RoomSession;
  others: MemberView[];
  online: boolean;
  summary: ConnectionSummary;
}): JSX.Element {
  const s = props.session;
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Connection" testid="connection-sheet">
      <div class="stack">
        <div class="connection-summary" data-testid="connection-summary">
          <span class={`dot dot-${props.summary.tone}`} aria-hidden="true" />
          <span class="connection-label">{props.summary.label}</span>
          <span class="muted small">{props.summary.hint}</span>
        </div>

        <fieldset class="group">
          <legend>Network</legend>
          <ul class="transports">
            <li>
              <span class={`dot dot-${props.online ? "ok" : "bad"}`} aria-hidden="true" />
              <span>{props.online ? "Online" : "Offline"}</span>
            </li>
          </ul>
        </fieldset>

        <fieldset class="group">
          <legend>Peers</legend>
          {props.others.length === 0 ? (
            <p class="muted small">No one else is in the room yet.</p>
          ) : (
            <ul class="transports">
              {props.others.map((m) => (
                <li key={m.peerId} data-testid="connection-peer">
                  <span
                    class={`dot dot-${m.blocked ? "bad" : m.link === "connected" ? "ok" : m.link === "closed" ? "bad" : "wait"}`}
                    aria-hidden="true"
                  />
                  <span>{m.nick}</span>
                  <span class="muted small tabular">{peerMeta(m)}</span>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <fieldset class="group">
          <legend>Rendezvous</legend>
          <ul class="transports">
            {s.transports.map((t) => (
              <li key={t.name} class="transport">
                <details>
                  <summary>
                    <span class={`dot dot-${stateTone(t.state)}`} aria-hidden="true" />
                    <span>{transportLabel(t.name)}</span>
                    <span class="muted small">
                      {t.endpoints.length
                        ? `${t.endpoints.filter((e) => e.state === "online").length}/${t.endpoints.length} online`
                        : t.state}
                    </span>
                  </summary>
                  {t.endpoints.length > 0 && (
                    <ul class="endpoints">
                      {t.endpoints.map((e) => (
                        <li key={e.url} title={e.url}>
                          <span class={`dot dot-${stateTone(e.state)}`} aria-hidden="true" />
                          <span>{hostOf(e.url)}</span>
                          {e.detail && <span class="muted small">{e.detail}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </li>
            ))}
          </ul>
          <p class="muted small">
            Only used to bootstrap. Once connected, new members are introduced through the encrypted
            mesh.
          </p>
        </fieldset>
      </div>
    </Sheet>
  );
}
