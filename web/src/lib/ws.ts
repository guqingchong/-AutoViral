// P2(2026-09-08):WS 建连带服务端注入的 authToken(handleUpgrade 鉴权)
function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = (window as any).__AUTH_TOKEN__;
  return `${proto}//${location.host}${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export function createWsConnection(
  onEvent: (event: string, data: any) => void
) {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryDelay = 1000;

  function connect() {
    if (closed) return;
    ws = new WebSocket(wsUrl("/ws"));

    ws.onopen = () => {
      retryDelay = 1000;
    };

    ws.onmessage = (msg) => {
      try {
        const { event, data } = JSON.parse(msg.data);
        onEvent(event, data);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}

export function createWorkWs(
  workId: string,
  onEvent: (event: string, data: any) => void
): { send: (text: string) => void; close: () => void } {
  let ws: WebSocket | null = null;
  let closed = false;
  let retryDelay = 1000;

  function connect() {
    if (closed) return;
    ws = new WebSocket(
      wsUrl(`/ws/browser/${encodeURIComponent(workId)}`)
    );

    ws.onopen = () => {
      retryDelay = 1000;
    };

    ws.onmessage = (msg) => {
      try {
        const { event, data } = JSON.parse(msg.data);
        onEvent(event, data);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return {
    send(text: string) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: "send", text }));
      }
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}

export function createTrendWs(
  sessionKey: string,
  onEvent: (event: string, data: any) => void
): { close: () => void } {
  let ws: WebSocket | null = null;
  let closed = false;

  function connect() {
    if (closed) return;
    ws = new WebSocket(
      wsUrl(`/ws/browser/${encodeURIComponent(sessionKey)}`)
    );

    ws.onmessage = (msg) => {
      try {
        const { event, data } = JSON.parse(msg.data);
        onEvent(event, data);
        // Auto-close on terminal events (no reconnect)
        if (event === "session_closed" || event === "research_done" || event === "research_error") {
          closed = true;
          ws?.close();
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      // No auto-reconnect for trend sessions
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}
