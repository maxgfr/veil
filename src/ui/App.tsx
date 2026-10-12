import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  encodeRoomKey,
  newRoomKey,
  parseRoomLink,
  parseRoomMode,
  type RoomMode,
  roomFragment,
} from "../crypto/room";
import { SettingsSheet } from "./components/SettingsSheet";
import { applyUpdate, updateReady } from "./pwa";
import { Home } from "./screens/Home";
import { Lobby, type LobbyChoice } from "./screens/Lobby";
import type { RoomSession } from "./session";
import { settings } from "./settings";

type Route =
  | { name: "home" }
  | { name: "lobby"; key: Uint8Array; passphrase: string; mode: RoomMode }
  | {
      name: "room";
      key: Uint8Array;
      mode: RoomMode;
      session: RoomSession;
      RoomView: typeof import("./screens/Room").Room;
    };

const loadRoom = () => Promise.all([import("./session"), import("./screens/Room")]);

function linkFor(key: Uint8Array, mode: RoomMode): string {
  return `${location.href.split("#")[0]}#${roomFragment(key, mode)}`;
}

function routeFromHash(): Route {
  const key = parseRoomLink(location.hash);
  return key
    ? { name: "lobby", key, passphrase: "", mode: parseRoomMode(location.hash) }
    : { name: "home" };
}

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const onHash = () => {
      setRoute((r) => {
        const key = parseRoomLink(location.hash);
        if (r.name === "room") return r;
        return key
          ? {
              name: "lobby",
              key,
              passphrase: r.name === "lobby" ? r.passphrase : "",
              mode: parseRoomMode(location.hash),
            }
          : { name: "home" };
      });
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // Warm up the room code while the user is in the lobby.
  useEffect(() => {
    if (route.name === "lobby") void loadRoom();
  }, [route.name]);

  const goLobby = (key: Uint8Array, passphrase: string, mode: RoomMode) => {
    history.pushState(null, "", `#${roomFragment(key, mode)}`);
    setError(null);
    setRoute({ name: "lobby", key, passphrase, mode });
  };

  const goHome = () => {
    history.pushState(null, "", location.pathname + location.search);
    setRoute({ name: "home" });
  };

  const join = async (key: Uint8Array, mode: RoomMode, c: LobbyChoice) => {
    setBusy(true);
    setError(null);
    try {
      const [{ RoomSession }, { Room }] = await loadRoom();
      const session = await RoomSession.join({
        key,
        passphrase: c.passphrase,
        nick: c.nick,
        settings: settings.value,
        audio: c.audio,
        video: c.video,
      });
      setRoute({ name: "room", key, mode, session, RoomView: Room });
    } catch (err) {
      console.error(err);
      setError("Could not open the room. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  let screen: JSX.Element;
  if (route.name === "home") {
    screen = (
      <Home
        onCreate={(passphrase, mode) => goLobby(newRoomKey(), passphrase, mode)}
        onJoin={(key, passphrase, mode) => goLobby(key, passphrase, mode)}
        onSettings={() => setSettingsOpen(true)}
      />
    );
  } else if (route.name === "lobby") {
    screen = (
      <Lobby
        key={`${route.mode}:${encodeRoomKey(route.key)}`}
        mode={route.mode}
        passphrase={route.passphrase}
        busy={busy}
        error={error}
        onBack={goHome}
        onJoin={(c) => void join(route.key, route.mode, c)}
      />
    );
  } else {
    const { RoomView, session } = route;
    screen = (
      <RoomView
        session={session}
        link={linkFor(route.key, route.mode)}
        mode={route.mode}
        onLeave={() => {
          void session.leave();
          goHome();
        }}
      />
    );
  }

  return (
    <>
      {updateReady.value && route.name !== "room" && (
        <div class="update" role="status">
          <span>A new version of Veil is available.</span>
          <button type="button" class="btn btn-sm btn-primary" onClick={applyUpdate}>
            Reload
          </button>
        </div>
      )}
      {screen}
      {route.name === "home" && (
        <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} inRoom={false} />
      )}
    </>
  );
}
