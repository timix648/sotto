// WebSocket client for BLUEPRINT §3.5.
//
// One connection, shared by every component, with reconnect and backoff.
//
// MECHANICS §4.10 — the unkillable failure banner — is the design constraint
// here. That bug was three defects at once: a polling effect that reset a local
// dismissal, alerts with no id and no acknowledge route, and a frame pushed
// unconditionally without checking whether it still applied. So this module
// reports a plain connection STATUS that reflects the socket and nothing else.
// It never raises an alert of its own, and it never re-raises one you dismissed.
import { WS_URL } from './config';
import type { WsFrame } from '@sotto/shared';

export type WsStatus = 'connecting' | 'open' | 'closed';

type FrameListener = (frame: WsFrame) => void;
type StatusListener = (status: WsStatus) => void;

const RECONNECT_MS = [500, 1000, 2000, 4000, 8000, 15000];

class SottoSocket {
  private ws: WebSocket | null = null;
  private frameListeners = new Set<FrameListener>();
  private statusListeners = new Set<StatusListener>();
  private subscribed = new Set<string>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;

  status: WsStatus = 'closed';

  private setStatus(s: WsStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private connect() {
    if (typeof window === 'undefined') return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.closedByUs = false;
    this.setStatus('connecting');

    let sock: WebSocket;
    try {
      sock = new WebSocket(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = sock;

    sock.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      // Re-subscribe everything after a reconnect, or the UI silently goes stale.
      this.subscribed.forEach((rfqId) => this.send({ type: 'subscribe', rfqId }));
    };

    sock.onmessage = (ev) => {
      let frame: WsFrame;
      try {
        frame = JSON.parse(String(ev.data)) as WsFrame;
      } catch {
        return; // a malformed frame is dropped, never rendered
      }
      if (!frame || typeof (frame as { type?: unknown }).type !== 'string') return;
      this.frameListeners.forEach((l) => l(frame));
    };

    sock.onerror = () => { /* onclose always follows; handle it there */ };

    sock.onclose = () => {
      this.ws = null;
      this.setStatus('closed');
      if (!this.closedByUs) this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.timer) return;
    const delay = RECONNECT_MS[Math.min(this.attempt, RECONNECT_MS.length - 1)];
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    this.connect();
    return () => {
      this.frameListeners.delete(listener);
      this.maybeIdle();
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => { this.statusListeners.delete(listener); };
  }

  subscribe(rfqId: string): () => void {
    this.subscribed.add(rfqId);
    this.connect();
    this.send({ type: 'subscribe', rfqId });
    return () => {
      this.subscribed.delete(rfqId);
      this.maybeIdle();
    };
  }

  /** Drop the socket once nothing is listening, so a closed tab stops retrying. */
  private maybeIdle() {
    if (this.frameListeners.size === 0 && this.subscribed.size === 0) {
      this.closedByUs = true;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.ws?.close();
      this.ws = null;
      this.setStatus('closed');
    }
  }
}

export const socket = new SottoSocket();
