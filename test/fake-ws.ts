/** A WebSocket the test drives by hand: it opens, hears and drops when told to. */
export class FakeWebSocket {
  static readonly all: FakeWebSocket[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  hear(msg: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(new Event("close") as CloseEvent);
  }

  static reset(): void {
    FakeWebSocket.all.length = 0;
  }
}

export const FakeWS = FakeWebSocket as unknown as new (url: string) => WebSocket;
