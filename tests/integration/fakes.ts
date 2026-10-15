/** Hand-rolled network doubles so integration tests exercise the real wiring end-to-end. */

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  open() {
    this.onopen?.();
  }
  push(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent<string>);
  }
  close() {
    this.closed = true;
  }
}

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}

export function resetFakes() {
  FakeEventSource.instances = [];
  FakeWebSocket.instances = [];
}
