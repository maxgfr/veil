/**
 * Short Authentication String: 4 emojis (24 bits) both people read aloud.
 * They match only if both sides see the same identities and the same DTLS
 * fingerprints, i.e. nobody (not even someone holding the room link) sits in
 * the middle of the connection.
 */
import { bytes, concat, utf8 } from "./bytes";
import { normalizeFingerprint } from "./session";

/** Matrix's SAS emoji table: 64 symbols picked to be easy to tell apart and to say aloud. */
export const SAS_EMOJIS: readonly (readonly [string, string])[] = [
  ["🐶", "Dog"],
  ["🐱", "Cat"],
  ["🦁", "Lion"],
  ["🐎", "Horse"],
  ["🦄", "Unicorn"],
  ["🐷", "Pig"],
  ["🐘", "Elephant"],
  ["🐰", "Rabbit"],
  ["🐼", "Panda"],
  ["🐓", "Rooster"],
  ["🐧", "Penguin"],
  ["🐢", "Turtle"],
  ["🐟", "Fish"],
  ["🐙", "Octopus"],
  ["🦋", "Butterfly"],
  ["🌷", "Flower"],
  ["🌳", "Tree"],
  ["🌵", "Cactus"],
  ["🍄", "Mushroom"],
  ["🌏", "Globe"],
  ["🌙", "Moon"],
  ["☁️", "Cloud"],
  ["🔥", "Fire"],
  ["🍌", "Banana"],
  ["🍎", "Apple"],
  ["🍓", "Strawberry"],
  ["🌽", "Corn"],
  ["🍕", "Pizza"],
  ["🎂", "Cake"],
  ["❤️", "Heart"],
  ["😀", "Smiley"],
  ["🤖", "Robot"],
  ["🎩", "Hat"],
  ["👓", "Glasses"],
  ["🔧", "Spanner"],
  ["🎅", "Santa"],
  ["👍", "Thumbs up"],
  ["☂️", "Umbrella"],
  ["⌛", "Hourglass"],
  ["⏰", "Clock"],
  ["🎁", "Gift"],
  ["💡", "Light bulb"],
  ["📕", "Book"],
  ["✏️", "Pencil"],
  ["📎", "Paperclip"],
  ["✂️", "Scissors"],
  ["🔒", "Lock"],
  ["🔑", "Key"],
  ["🔨", "Hammer"],
  ["☎️", "Telephone"],
  ["🏁", "Flag"],
  ["🚂", "Train"],
  ["🚲", "Bicycle"],
  ["✈️", "Aeroplane"],
  ["🚀", "Rocket"],
  ["🏆", "Trophy"],
  ["⚽", "Ball"],
  ["🎸", "Guitar"],
  ["🎺", "Trumpet"],
  ["🔔", "Bell"],
  ["⚓", "Anchor"],
  ["🎧", "Headphones"],
  ["📁", "Folder"],
  ["📌", "Pin"],
];

export interface SasParty {
  peerId: string;
  edPub: Uint8Array;
  fingerprint: string;
}

export interface Sas {
  emojis: string[];
  names: string[];
}

export async function computeSas(sasSalt: Uint8Array, a: SasParty, b: SasParty): Promise<Sas> {
  const [lo, hi] = a.peerId < b.peerId ? [a, b] : [b, a];
  const msg = concat(
    utf8("veil/sas/v1"),
    lo.edPub,
    hi.edPub,
    utf8(`${normalizeFingerprint(lo.fingerprint)}|${normalizeFingerprint(hi.fingerprint)}`),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(sasSalt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const bits = ((mac[0] as number) << 16) | ((mac[1] as number) << 8) | (mac[2] as number);
  const idx = [18, 12, 6, 0].map((shift) => (bits >> shift) & 63);
  const picks = idx.map((i) => SAS_EMOJIS[i] as readonly [string, string]);
  return { emojis: picks.map((p) => p[0]), names: picks.map((p) => p[1]) };
}
