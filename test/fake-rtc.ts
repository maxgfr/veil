/**
 * In-memory stand-in for RTCPeerConnection, faithful enough to exercise
 * negotiation logic (offer/answer state machine, implicit rollback, glare)
 * and DataChannel messaging between peers in unit tests. Two fakes
 * "connect" once each holds the other's description in a stable state.
 */

let nextId = 1;
const registry = new Map<number, FakePeerConnection>();

type Handler = ((ev: Event) => void) | null;

export class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: Handler = null;
  onclose: Handler = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  remote: FakeDataChannel | null = null;
  /** Total bytes sent (for assertions). */
  sentBytes = 0;

  constructor(
    readonly label: string,
    readonly id: number,
  ) {
    super();
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== "open") throw new Error("InvalidStateError: channel not open");
    const remote = this.remote;
    let payload: string | ArrayBuffer;
    if (typeof data === "string") payload = data;
    else if (data instanceof ArrayBuffer) payload = data.slice(0);
    else payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
    this.sentBytes += typeof payload === "string" ? payload.length : payload.byteLength;
    setTimeout(() => {
      if (remote?.readyState !== "open") return;
      const ev = new MessageEvent("message", { data: payload });
      remote.onmessage?.(ev);
      remote.dispatchEvent(ev);
    }, 0);
  }

  _open(): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    const ev = new Event("open");
    this.onopen?.(ev);
    this.dispatchEvent(ev);
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    const ev = new Event("close");
    this.onclose?.(ev);
    this.dispatchEvent(ev);
    const r = this.remote;
    this.remote = null;
    if (r) setTimeout(() => r.close(), 0);
  }
}

interface Desc {
  type: RTCSdpType;
  sdp: string;
}

function partnerOf(sdp: string | undefined): number | null {
  const m = sdp?.match(/^a=x-fake:(\d+)/m);
  return m ? Number(m[1]) : null;
}

export class FakePeerConnection extends EventTarget {
  readonly fakeId = nextId++;
  readonly fingerprint = `sha-256 ${Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase(),
  ).join(":")}`;
  signalingState: RTCSignalingState = "stable";
  iceGatheringState: RTCIceGatheringState = "new";
  connectionState: RTCPeerConnectionState = "new";
  localDescription: Desc | null = null;
  remoteDescription: Desc | null = null;
  onnegotiationneeded: Handler = null;
  ontrack: Handler = null;
  onconnectionstatechange: Handler = null;
  readonly channels: FakeDataChannel[] = [];
  private version = 0;
  private needsNegotiation = false;
  private negotiationQueued = false;
  restarts = 0;

  constructor(readonly config: RTCConfiguration = {}) {
    super();
    registry.set(this.fakeId, this);
  }

  createDataChannel(label: string, init: RTCDataChannelInit = {}): FakeDataChannel {
    const dc = new FakeDataChannel(label, init.id ?? this.channels.length);
    this.channels.push(dc);
    if (!this.localDescription && !this.remoteDescription) this.queueNegotiation();
    if (this.connectionState === "connected") this.pairChannels();
    return dc;
  }

  private queueNegotiation(): void {
    this.needsNegotiation = true;
    if (this.negotiationQueued) return;
    this.negotiationQueued = true;
    setTimeout(() => {
      this.negotiationQueued = false;
      if (
        !this.needsNegotiation ||
        this.signalingState !== "stable" ||
        this.connectionState === "closed"
      )
        return;
      this.needsNegotiation = false;
      const ev = new Event("negotiationneeded");
      this.onnegotiationneeded?.(ev);
      this.dispatchEvent(ev);
    }, 0);
  }

  private sdp(type: RTCSdpType): string {
    this.version++;
    return `v=0\r\no=fake ${this.fakeId} ${this.version} IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:${this.fingerprint}\r\na=x-fake:${this.fakeId}\r\na=x-type:${type}\r\n`;
  }

  private gather(): void {
    this.iceGatheringState = "gathering";
    setTimeout(() => {
      this.iceGatheringState = "complete";
      this.dispatchEvent(new Event("icegatheringstatechange"));
    }, 1);
  }

  async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
    await Promise.resolve();
    if (this.connectionState === "closed") throw new Error("InvalidStateError: closed");
    const type = desc?.type ?? (this.signalingState === "have-remote-offer" ? "answer" : "offer");
    if (type === "offer") {
      if (this.signalingState !== "stable" && this.signalingState !== "have-local-offer") {
        throw new Error(`InvalidStateError: cannot offer in ${this.signalingState}`);
      }
      this.localDescription = { type, sdp: this.sdp(type) };
      this.signalingState = "have-local-offer";
    } else if (type === "answer") {
      if (this.signalingState !== "have-remote-offer")
        throw new Error("InvalidStateError: no remote offer");
      this.localDescription = { type, sdp: this.sdp(type) };
      this.signalingState = "stable";
      this.onStable();
    } else if (type === "rollback") {
      this.signalingState = "stable";
    }
    this.gather();
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await Promise.resolve();
    if (this.connectionState === "closed") throw new Error("InvalidStateError: closed");
    if (desc.type === "offer") {
      // Implicit rollback, as in modern browsers.
      if (this.signalingState === "have-local-offer") this.signalingState = "stable";
      if (this.signalingState !== "stable")
        throw new Error(`InvalidStateError: offer in ${this.signalingState}`);
      this.remoteDescription = { type: "offer", sdp: desc.sdp ?? "" };
      this.signalingState = "have-remote-offer";
    } else if (desc.type === "answer") {
      if (this.signalingState !== "have-local-offer") {
        throw new Error(`InvalidStateError: answer in ${this.signalingState}`);
      }
      this.remoteDescription = { type: "answer", sdp: desc.sdp ?? "" };
      this.signalingState = "stable";
      this.onStable();
    }
  }

  private onStable(): void {
    const partner = registry.get(partnerOf(this.remoteDescription?.sdp) ?? -1);
    if (
      partner &&
      partner.signalingState === "stable" &&
      partnerOf(partner.remoteDescription?.sdp) === this.fakeId &&
      this.connectionState !== "connected"
    ) {
      setTimeout(() => {
        this.setConnection("connected");
        partner.setConnection("connected");
        this.pairChannels();
      }, 2);
    }
    if (this.needsNegotiation) this.queueNegotiation();
  }

  private pairChannels(): void {
    const partner = registry.get(partnerOf(this.remoteDescription?.sdp) ?? -1);
    if (!partner) return;
    for (const dc of this.channels) {
      const other = partner.channels.find((c) => c.id === dc.id && c.readyState === "connecting");
      if (dc.readyState === "connecting" && other) {
        dc.remote = other;
        other.remote = dc;
        dc._open();
        other._open();
      }
    }
  }

  setConnection(s: RTCPeerConnectionState): void {
    if (this.connectionState === s || this.connectionState === "closed") return;
    this.connectionState = s;
    const ev = new Event("connectionstatechange");
    this.onconnectionstatechange?.(ev);
    this.dispatchEvent(ev);
  }

  restartIce(): void {
    this.restarts++;
    this.queueNegotiation();
  }

  getSenders(): RTCRtpSender[] {
    return [];
  }

  getReceivers(): RTCRtpReceiver[] {
    return [];
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return [];
  }

  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport;
  }

  close(): void {
    if (this.connectionState === "closed") return;
    for (const dc of this.channels) dc.close();
    this.connectionState = "closed";
    this.signalingState = "closed";
    registry.delete(this.fakeId);
  }
}

export const FakePC = FakePeerConnection as unknown as typeof RTCPeerConnection;
