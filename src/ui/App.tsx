import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { encodeRoomKey, newRoomKey, parseRoomLink } from "../crypto/room";
import { SettingsSheet } from "./components/SettingsSheet";
import { applyUpdate, updateReady } from "./pwa";
import { Home } from "./screens/Home";
import { Lobby, type LobbyChoice } from "./screens/Lobby";
import type { RoomSession } from "./session";
import { settings } from "./settings";

type Route =
  | { name: "home" }
  | { name: "lobby"; key: Uint8Array; passphrase: string }
  | {
      name: "room";
      key: Uint8Array;
      session: RoomSession;
      RoomView: typeof import("./screens/Room").Room;
    };

const loadRoom = () => Promise.all([import("./session"), import("./screens/Room")]);

function linkFor(key: Uint8Array): string {
  return `${location.href.split("#")[0]}#${encodeRoomKey(key)}`;
}

function routeFromHash(): Route {
  const key = parseRoomLink(location.hash);
  return key ? { name: "lobby", key, passphrase: "" } : { name: "home" };
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
          ? { name: "lobby", key, passphrase: r.name === "lobby" ? r.passphrase : "" }
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

  const goLobby = (key: Uint8Array, passphrase: string) => {
    history.pushState(null, "", `#${encodeRoomKey(key)}`);
    setError(null);
    setRoute({ name: "lobby", key, passphrase });
  };

  const goHome = () => {
    history.pushState(null, "", location.pathname + location.search);
    setRoute({ name: "home" });
  };

  const join = async (key: Uint8Array, c: LobbyChoice) => {
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
      setRoute({ name: "room", key, session, RoomView: Room });
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
        onCreate={(passphrase) => goLobby(newRoomKey(), passphrase)}
        onJoin={(key, passphrase) => goLobby(key, passphrase)}
        onSettings={() => setSettingsOpen(true)}
      />
    );
  } else if (route.name === "lobby") {
    screen = (
      <Lobby
        key={encodeRoomKey(route.key)}
        passphrase={route.passphrase}
        busy={busy}
        error={error}
        onBack={goHome}
        onJoin={(c) => void join(route.key, c)}
      />
    );
  } else {
    const { RoomView, session } = route;
    screen = (
      <RoomView
        session={session}
        link={linkFor(route.key)}
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
