/**
 * Chat state: messages, delivery receipts and typing indicators. Text is only
 * ever rendered as text nodes (never as HTML) by the UI.
 */
import { randomBytes, toB64u } from "../crypto/bytes";
import { type AppMessage, MAX_CHAT_LENGTH } from "../mesh/protocol";

export interface ChatMessage {
  id: string;
  author: string;
  text: string;
  ts: number;
  mine: boolean;
  /** Members who confirmed receipt (only tracked for our own messages). */
  delivered: Set<string>;
  /** Set when the message announces a file. */
  fileId?: string;
}

export interface ChatDeps {
  peerId: string;
  send(msg: AppMessage): Promise<void>;
  onChange(): void;
  now?: () => number;
}

const TYPING_TTL_MS = 5000;
const TYPING_THROTTLE_MS = 2500;
const RECEIPT_BATCH_MS = 800;
const MAX_HISTORY = 5000;

export function newMessageId(): string {
  return toB64u(randomBytes(12));
}

export class Chat {
  readonly messages: ChatMessage[] = [];
  private readonly ids = new Set<string>();
  readonly typing = new Map<string, number>();
  private pendingReceipts: string[] = [];
  private receiptTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTypingSent = 0;
  private typingOn = false;
  private readonly now: () => number;

  constructor(private readonly d: ChatDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Returns the message, or null if empty. Long texts are cut at the protocol limit. */
  async sendText(raw: string): Promise<ChatMessage | null> {
    const text = raw.replace(/\s+$/u, "").slice(0, MAX_CHAT_LENGTH);
    if (!text.trim()) return null;
    const msg: ChatMessage = {
      id: newMessageId(),
      author: this.d.peerId,
      text,
      ts: this.now(),
      mine: true,
      delivered: new Set(),
    };
    this.push(msg);
    this.typingOn = false;
    await this.d.send({ type: "chat", id: msg.id, text, ts: msg.ts });
    return msg;
  }

  /** Records a local system-ish entry (e.g. a file we offered). */
  addFileEntry(author: string, fileId: string, mine: boolean, ts = this.now()): void {
    this.push({ id: `file-${fileId}`, author, text: "", ts, mine, delivered: new Set(), fileId });
  }

  setTyping(on: boolean): void {
    const now = this.now();
    if (on && this.typingOn && now - this.lastTypingSent < TYPING_THROTTLE_MS) return;
    if (!on && !this.typingOn) return;
    this.typingOn = on;
    this.lastTypingSent = now;
    void this.d.send({ type: "typing", on });
  }

  onApp(author: string, msg: AppMessage): void {
    switch (msg.type) {
      case "chat": {
        if (this.ids.has(msg.id)) return;
        // Clamp a remote clock that is far off, so ordering stays sane.
        const now = this.now();
        const ts = Math.abs(msg.ts - now) > 5 * 60_000 ? now : msg.ts;
        this.typing.delete(author);
        this.push({ id: msg.id, author, text: msg.text, ts, mine: false, delivered: new Set() });
        this.queueReceipt(msg.id);
        return;
      }
      case "receipt": {
        let changed = false;
        for (const id of msg.ids) {
          const m = this.byId(id);
          if (m?.mine && !m.delivered.has(author)) {
            m.delivered.add(author);
            changed = true;
          }
        }
        if (changed) this.d.onChange();
        return;
      }
      case "typing":
        if (msg.on) this.typing.set(author, this.now() + TYPING_TTL_MS);
        else this.typing.delete(author);
        this.d.onChange();
        return;
      default:
        return;
    }
  }

  /** Members currently typing (expired entries are pruned). */
  typingNow(): string[] {
    const now = this.now();
    const out: string[] = [];
    for (const [id, until] of this.typing) {
      if (until < now) this.typing.delete(id);
      else out.push(id);
    }
    return out;
  }

  forget(author: string): void {
    if (this.typing.delete(author)) this.d.onChange();
  }

  private byId(id: string): ChatMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--)
      if (this.messages[i]?.id === id) return this.messages[i];
    return undefined;
  }

  private push(m: ChatMessage): void {
    this.ids.add(m.id);
    // Keep chronological order even if a message arrives late.
    let i = this.messages.length;
    while (i > 0 && (this.messages[i - 1] as ChatMessage).ts > m.ts) i--;
    this.messages.splice(i, 0, m);
    if (this.messages.length > MAX_HISTORY) {
      const dropped = this.messages.shift();
      if (dropped) this.ids.delete(dropped.id);
    }
    this.d.onChange();
  }

  private queueReceipt(id: string): void {
    this.pendingReceipts.push(id);
    if (this.receiptTimer) return;
    this.receiptTimer = setTimeout(() => {
      this.receiptTimer = undefined;
      const ids = this.pendingReceipts.splice(0, 256);
      if (ids.length) void this.d.send({ type: "receipt", ids });
      if (this.pendingReceipts.length) this.queueReceipt(this.pendingReceipts.pop() as string);
    }, RECEIPT_BATCH_MS);
  }

  dispose(): void {
    clearTimeout(this.receiptTimer);
  }
}
