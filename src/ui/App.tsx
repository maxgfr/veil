import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  encodeRoomKey,
  newRoomKey,
  parseRoomLink,
  parseRoomMode,
  type RoomMode,
  roomFragment,
} from "../crypto/room";
import { Icon } from "./components/Icons";
import { SettingsSheet } from "./components/SettingsSheet";
import { browserOnline } from "./connection";
import { applyUpdate, updateReady } from "./pwa";
import { Home } from "./screens/Home";
import { Lobby, type LobbyChoice } from "./screens/Lobby";
import type { RoomSession } from "./session";
import { settings, turnReady } from "./settings";
import { checkSupport } from "./support";

type Route =
  | { name: "home"; notice?: string }
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

const INCOMPLETE_LINK = "This link looks incomplete. Ask for it again.";

/** Home for no fragment; home with a notice for one that holds no key (the link was cut). */
function homeRoute(): Route {
  return location.hash.length > 1 ? { name: "home", notice: INCOMPLETE_LINK } : { name: "home" };
}

function routeFromHash(): Route {
  const key = parseRoomLink(location.hash);
  return key
    ? { name: "lobby", key, passphrase: "", mode: parseRoomMode(location.hash) }
    : homeRoute();
}

/** Another room's link, opened while in a room. */
interface NextRoom {
  key: Uint8Array;
  mode: RoomMode;
}

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nextRoom, setNextRoom] = useState<NextRoom | null>(null);
  const current = useRef(route);
  current.current = route;

  useEffect(() => {
    const onHash = () => {
      const key = parseRoomLink(location.hash);
      const r = current.current;
      if (r.name === "room") {
        // Never drop a live room for a link: ask first. The same room's link changes nothing.
        if (key && encodeRoomKey(key) !== encodeRoomKey(r.key))
          setNextRoom({ key, mode: parseRoomMode(location.hash) });
        return;
      }
      setRoute((r) =>
        key
          ? {
              name: "lobby",
              key,
              passphrase: r.name === "lobby" ? r.passphrase : "",
              mode: parseRoomMode(location.hash),
            }
          : homeRoute(),
      );
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
    const unsupported = await checkSupport();
    if (unsupported) {
      setError(unsupported);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const [{ RoomSession }, { Room }] = await loadRoom();
      await turnReady;
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
        newLink={(mode) => linkFor(newRoomKey(), mode)}
        onSettings={() => setSettingsOpen(true)}
        notice={route.notice}
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
    const here = route;
    screen = (
      <RoomView
        session={session}
        link={linkFor(route.key, route.mode)}
        mode={route.mode}
        onLeave={() => {
          void session.leave();
          setNextRoom(null);
          goHome();
        }}
        otherRoom={
          nextRoom && {
            onOpen: () => {
              void session.leave();
              setNextRoom(null);
              // The address bar already shows the new link.
              setError(null);
              setRoute({ name: "lobby", key: nextRoom.key, passphrase: "", mode: nextRoom.mode });
            },
            onDismiss: () => {
              setNextRoom(null);
              history.replaceState(null, "", `#${roomFragment(here.key, here.mode)}`);
            },
          }
        }
      />
    );
  }

  return (
    <>
      {route.name !== "room" &&
        (!browserOnline.value ? (
          <div class="update offline" role="status" data-testid="offline">
            <Icon name="wifi" size={18} />
            <span>You're offline. Rooms need a network to connect.</span>
          </div>
        ) : (
          updateReady.value && (
            <div class="update" role="status">
              <span>A new version of Veil is available.</span>
              <button type="button" class="btn btn-sm btn-primary" onClick={applyUpdate}>
                Reload
              </button>
            </div>
          )
        ))}
      {screen}
      {route.name === "home" && (
        <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} inRoom={false} />
      )}
    </>
  );
}
