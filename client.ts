import { Message, unpackMessage } from "./common.ts";

/**
 * WebSocket started connecting.
 *
 * @category Client
 */
export type EventConnecting = "connecting";

/**
 * WebSocket has opened.
 *
 * @category Client
 */
export type EventOpened = "opened";

/**
 * Open WebSocket connection has been acknowledged.
 *
 * @category Client
 */
export type EventConnected = "connected";

/**
 * `PingMessage` has been received or sent.
 *
 * @category Client
 */
export type EventPing = "ping";

/**
 * `PongMessage` has been received or sent.
 *
 * @category Client
 */
export type EventPong = "pong";

/**
 * A message has been received.
 *
 * @category Client
 */
export type EventMessage = "message";

/**
 * WebSocket connection has closed.
 *
 * @category Client
 */
export type EventClosed = "closed";

/**
 * WebSocket connection had an error or client had an internal error.
 *
 * @category Client
 */
export type EventError = "error";

/**
 * All events that could occur.
 *
 * @category Client
 */
export type Event =
  | EventConnecting
  | EventOpened
  | EventConnected
  | EventPing
  | EventPong
  | EventMessage
  | EventClosed
  | EventError;

/** @category Client */
export type EventConnectingListener = () => void;

/**
 * The first argument is actually the `WebSocket`, but to avoid
 * bundling DOM typings because the client can run in Node env too,
 * you should assert the websocket type during implementation.
 *
 * @category Client
 */
export type EventOpenedListener = (socket: unknown) => void;

/**
 * The first argument is actually the `WebSocket`, but to avoid
 * bundling DOM typings because the client can run in Node env too,
 * you should assert the websocket type during implementation.
 *
 * Also, the second argument is the optional payload that the server may
 * send through the `ConnectionAck` message.
 *
 * @category Client
 */
export type EventConnectedListener = (
  socket: unknown,
  payload: ConnectionAckMessage["payload"]
) => void;

/**
 * The first argument communicates whether the ping was received from the server.
 * If `false`, the ping was sent by the client.
 *
 * @category Client
 */
export type EventPingListener = (
  received: boolean,
  payload: PingMessage["payload"]
) => void;

/**
 * The first argument communicates whether the pong was received from the server.
 * If `false`, the pong was sent by the client.
 *
 * @category Client
 */
export type EventPongListener = (
  received: boolean,
  payload: PongMessage["payload"]
) => void;

/**
 * Called for all **valid** messages received by the client. Mainly useful for
 * debugging and logging received messages.
 *
 * @category Client
 */
export type EventMessageListener = (message: Message) => void;

/**
 * The argument is actually the websocket `CloseEvent`, but to avoid
 * bundling DOM typings because the client can run in Node env too,
 * you should assert the websocket type during implementation.
 *
 * @category Client
 */
export type EventClosedListener = (event: unknown) => void;

/**
 * Events dispatched from the WebSocket `onerror` are handled in this listener,
 * as well as all internal client errors that could throw.
 *
 * @category Client
 */
export type EventErrorListener = (error: unknown) => void;

/** @category Client */
export type EventListener<E extends Event> = E extends EventConnecting
  ? EventConnectingListener
  : E extends EventOpened
  ? EventOpenedListener
  : E extends EventConnected
  ? EventConnectedListener
  : E extends EventPing
  ? EventPingListener
  : E extends EventPong
  ? EventPongListener
  : E extends EventMessage
  ? EventMessageListener
  : E extends EventClosed
  ? EventClosedListener
  : E extends EventError
  ? EventErrorListener
  : never;

export interface ClientOptions<OpenPayload, InitPayload> {
  /**
   * URL of the Subby Websocket Server.
   *
   * If the option is a function, it will be called on every WebSocket connection attempt.
   * Returning a promise is supported too and the connecting phase will stall until it
   * resolves with the URL.
   *
   * A good use-case for having a function is when using the URL for authentication,
   * where subsequent reconnects (due to auth) may have a refreshed identity token in
   * the URL.
   */
  url: string | (() => Promise<string> | string);

  /**
   * Called when the server has sent a connection open message. If not specified,
   * the client will automatically emit a connection init message after receiving
   * the open message.
   */
  onInit?: (openPayload?: OpenPayload) => Promise<InitPayload> | InitPayload;

  /**
   * How many times should the client try to reconnect to the server before giving up.
   */
  reconnectAttempts?: number;

  /**
   * Control the wait time between retries.
   */
  retryWait?: (retries: number) => Promise<void>;
}

export function createClient<OpenPayload, InitPayload>(
  options: ClientOptions<OpenPayload, InitPayload>
) {
  const retryWait = options.retryWait || randomisedExponentialBackoff;

  let id = 1;
  function generateID() {
    return id++;
  }

  let ws;
  if (typeof WebSocket !== "undefined") {
    ws = WebSocket;
    // @ts-expect-error: Support other envs than Deno
  } else if (typeof global !== "undefined") {
    ws =
      // @ts-expect-error: Support other envs than Deno
      global.WebSocket ||
      // @ts-expect-error: Support more browsers
      global.MozWebSocket;
  } else if (typeof window !== "undefined") {
    ws =
      // @ts-expect-error: Support other envs than Deno
      window.WebSocket ||
      // @ts-expect-error: Support more browsers
      window.MozWebSocket;
  }
  if (!ws)
    throw new Error(
      "WebSocket implementation missing; on Node you can `import WebSocket from 'ws';` and pass `webSocketImpl: WebSocket` to `createClient`"
    );
  const WebSocketImpl = ws;

  // websocket status emitter, subscriptions are handled differently
  const emitter = (() => {
    const message = (() => {
      const listeners: { [key: string]: EventMessageListener } = {};
      return {
        on(id: string, listener: EventMessageListener) {
          listeners[id] = listener;
          return () => {
            delete listeners[id];
          };
        },
        emit(message: Message) {
          if ("id" in message) listeners[message.id]?.(message);
        },
      };
    })();
    const listeners: { [event in Event]: EventListener<event>[] } = {
      connecting: [],
      opened: [],
      connected: [],
      ping: [],
      pong: [],
      message: [message.emit],
      closed: [],
      error: [],
    };

    return {
      onMessage: message.on,
      on<E extends Event>(event: E, listener: EventListener<E>) {
        const l = listeners[event] as EventListener<E>[];
        l.push(listener);
        return () => {
          l.splice(l.indexOf(listener), 1);
        };
      },
      emit<E extends Event>(event: E, ...args: Parameters<EventListener<E>>) {
        // we copy the listeners so that unlistens dont "pull the rug under our feet"
        for (const listener of [...listeners[event]]) {
          // @ts-expect-error: The args should fit
          listener(...args);
        }
      },
    };
  })();

  let connecting: ReturnType<typeof connect> | undefined,
    retrying = false,
    retries = 0,
    disposed = false;

  return {
    subscribe(payload, sink) {
      const id = generateID();

      let done = false,
        errored = false,
        releaser = () => {
          // for handling completions before connect
          locks--;
          done = true;
        };

      (async () => {
        locks++;
        for (;;) {
          try {
            const [socket, release, waitForReleaseOrThrowOnClose] =
              await connect();

            // if done while waiting for connect, release the connection lock right away
            if (done) return release();

            const unlisten = emitter.onMessage(id, (message) => {
              switch (message.type) {
                case MessageType.Next: {
                  sink.next(message.payload as any);
                  return;
                }
                case MessageType.Error: {
                  (errored = true), (done = true);
                  sink.error(message.payload);
                  releaser();
                  return;
                }
                case MessageType.Complete: {
                  done = true;
                  releaser(); // release completes the sink
                  return;
                }
              }
            });

            socket.send(
              stringifyMessage<MessageType.Subscribe>(
                {
                  id,
                  type: MessageType.Subscribe,
                  payload,
                },
                replacer
              )
            );

            releaser = () => {
              if (!done && socket.readyState === WebSocketImpl.OPEN)
                // if not completed already and socket is open, send complete message to server on release
                socket.send(
                  stringifyMessage<MessageType.Complete>(
                    {
                      id,
                      type: MessageType.Complete,
                    },
                    replacer
                  )
                );
              locks--;
              done = true;
              release();
            };

            // either the releaser will be called, connection completed and
            // the promise resolved or the socket closed and the promise rejected.
            // whatever happens though, we want to stop listening for messages
            await waitForReleaseOrThrowOnClose.finally(unlisten);

            return; // completed, shouldnt try again
          } catch (errOrCloseEvent) {
            if (!shouldRetryConnectOrThrow(errOrCloseEvent)) return;
          }
        }
      })()
        .then(() => {
          // delivering either an error or a complete terminates the sequence
          if (!errored) sink.complete();
        }) // resolves on release or normal closure
        .catch((err) => {
          sink.error(err);
        }); // rejects on close events and errors

      return () => {
        // dispose only of active subscriptions
        if (!done) releaser();
      };
    },
  };
}

/**
 * Connect to a Subby client asynchronously.
 */
export async function connect(
  url: string
): Promise<
  [socket: WebSocket, throwOnCloseOrWaitForComplete: () => Promise<void>]
> {
  const ws = new WebSocket(url);

  // Set binary type to array buffer
  ws.binaryType = "arraybuffer";

  /**
   * For if the socket closes before you start listening
   * for the
   */
  let closed: CloseEvent;

  /**
   * Once promises settle, all following resolve/reject calls will simply
   * be ignored. So, for the sake of simplicity, I wont be unlistening.
   */
  await new Promise<void>((resolve, reject) => {
    /**
     * From: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications
     * > If an error occurs while attempting to connect, first a simple event
     * > with the name error is sent to the WebSocket object (thereby invoking
     * > its onerror handler), and then the CloseEvent is sent to the WebSocket
     * > object (thereby invoking its onclose handler) to indicate the reason for
     * > the connection's closing.
     *
     * Keeping this in mind, listening to the `onclose` event is sufficient.
     * Close events (code + reason) should be used to communicate any critical
     * problem with the socket.
     */
    ws.onclose = (event) => {
      closed = event;
      reject(event);
    };

    /**
     * Instead of relying on the onopen event, we know that we will receive a
     * challenge event as soon as the websocket opens, which indicates the connection
     * is established.
     */
    ws.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
      const view = new Uint8Array(data);
      const msg = unpackMessage(view);

      if (msg.parent === RootMessageType.Ack) {
        resolve();
      } else {
        reject(new Error("Connection was'nt acknowledged"));
      }
    };
  });

  return [
    ws,

    /**
     * Promise that will fire when the connection closes or completes.
     */
    () =>
      new Promise<void>((resolve, reject) => {
        const check = (event: CloseEvent) => {
          if (event.code === 1000) {
            resolve();
          } else {
            reject(event);
          }
        };
        if (closed) return check(closed);
        ws.addEventListener("close", check);
      }),
  ];
}

async function randomisedExponentialBackoff(retries: number) {
  let retryDelay = 1000; // start with 1s delay
  for (let i = 0; i < retries; i++) {
    retryDelay *= 2;
  }
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      retryDelay +
        // add random timeout from 300ms to 3s
        Math.floor(Math.random() * (3000 - 300) + 300)
    )
  );
}
