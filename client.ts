import {
  CloseCode,
  Message,
  MessageType,
  packMessage,
  PingMessage,
  PongMessage,
  Sink,
  SUBBY_WS_PROTOCOL,
  unpackMessage,
} from "./common.ts";
import { isObject, limitCloseReason } from "./utils.ts";

type ClientStatus =
  | "closed" // Socket is closed
  | "connecting" // Socket is connecting
  | "connected" // Socket is connected but didn't receive open message yet
  | "opened" // Received open message from server, not yet ready for messages
  | "acknowledged"; // server has acknowledged the connection, messages can now flow

export type EventClosed = "closed";
export type EventConnecting = "connecting";
export type EventConnected = "connected";
export type EventOpened = "opened";
export type EventAcknowledged = "acknowledged";
export type EventMessage = "message";
export type EventError = "error";
export type EventPing = "ping";
export type EventPong = "pong";

/**
 * All events that could occur.
 *
 * @category Client
 */
export type Event =
  | EventClosed
  | EventConnecting
  | EventConnected
  | EventOpened
  | EventAcknowledged
  | EventMessage
  | EventError
  | EventPing
  | EventPong;

/**
 * Fires when the client is closed.
 */
export type EventClosedListener = (event: CloseEvent) => void;

/**
 * Fires when the client is connecting.
 */
export type EventConnectingListener = () => void;

/**
 * Fires when the websocket connection is established but not yet opened by the server.
 */
export type EventConnectedListener = (socket: WebSocket) => void;

/**
 * Fires when the connection has been opened by the server. This is just
 * a 'notification' listener. Use onOpen to 'respond' to the open message with
 * an init message.
 */
export type EventOpenedListener = (
  socket: WebSocket,
  payload?: unknown
) => void;

/**
 * Fires when the connection has been acknowledged by the server.
 */
export type EventAcknowledgedListener = (
  socket: WebSocket,
  payload?: unknown
) => void;

/**
 * Called for all **valid** messages received by the client. Mainly useful for
 * debugging and logging received messages.
 *
 * @category Client
 */
export type EventMessageListener = (message: Message) => void;

/**
 * Events dispatched from the WebSocket `onerror` are handled in this listener,
 * as well as all internal client errors that could throw.
 *
 * @category Client
 */
export type EventErrorListener = (error: unknown) => void;

/**
 * The first argument communicates whether the ping was received from the server.
 * If `false`, the ping was sent by the client.
 *
 * @category Client
 */
export type EventPingListener = (
  received: boolean,
  payload: PingMessage[1]
) => void;

/**
 * The first argument communicates whether the pong was received from the server.
 * If `false`, the pong was sent by the client.
 *
 * @category Client
 */
export type EventPongListener = (
  received: boolean,
  payload: PongMessage[1]
) => void;

/** @category Client */
export type EventListener<E extends Event> = E extends EventConnecting
  ? EventConnectingListener
  : E extends EventConnected
  ? EventConnectedListener
  : E extends EventOpened
  ? EventOpenedListener
  : E extends EventAcknowledged
  ? EventAcknowledgedListener
  : E extends EventMessage
  ? EventMessageListener
  : E extends EventClosed
  ? EventClosedListener
  : E extends EventError
  ? EventErrorListener
  : E extends EventPing
  ? EventPingListener
  : E extends EventPong
  ? EventPongListener
  : never;

export interface ClientOptions<OpenPayload, InitPayload, AckPayload> {
  /**
   * URL of the Subby over WebSocket Protocol compliant server to connect.
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
   * Controls when should the connection be established.
   *
   * - `false`: Establish a connection immediately. Use `onNonLazyError` to handle errors.
   * - `true`: Establish a connection on first subscribe and close on last unsubscribe. Use
   * the subscription sink's `error` to handle errors.
   *
   * @default true
   */
  lazy?: boolean;

  /**
   * Used ONLY when the client is in non-lazy mode (`lazy = false`). When
   * using this mode, the errors might have no sinks to report to; however,
   * to avoid swallowing errors, consider using `onNonLazyError`,  which will
   * be called when either:
   * - An unrecoverable error/close event occurs
   * - Silent retry attempts have been exceeded
   *
   * After a client has errored out, it will NOT perform any automatic actions.
   *
   * The argument can be a websocket `CloseEvent` or an `Error`. To avoid bundling
   * DOM types, you should derive and assert the correct type. When receiving:
   * - A `CloseEvent`: retry attempts have been exceeded or the specific
   * close event is labeled as fatal (read more in `retryAttempts`).
   * - An `Error`: some internal issue has occured, all internal errors are
   * fatal by nature.
   *
   * @default console.error
   */
  onNonLazyError?: (errorOrCloseEvent: unknown) => void;

  /**
   * How long should the client wait before closing the socket after the last oparation has
   * completed. This is meant to be used in combination with `lazy`. You might want to have
   * a calmdown time before actually closing the connection. Kinda' like a lazy close "debounce".
   *
   * @default 0
   */
  lazyCloseTimeout?: number;

  /**
   * The timout between dispatched keep-alive messages, naimly server pings. Internally
   * dispatches the `PingMessage` type to the server and expects a `PongMessage` in response.
   * This helps with making sure that the connection with the server is alive and working.
   *
   * Timeout countdown starts from the moment the socket was opened and subsequently
   * after every received `PongMessage`.
   *
   * @default 0
   */
  keepAlive?: number;

  /**
   * How many times should the client try to reconnect to the server before giving up.
   */
  retryAttempts?: number;

  /**
   * Control the wait time between retries.
   */
  retryWait?: (retries: number) => Promise<void>;

  /**
   * Register listeners before initialising the client. This way
   * you can ensure to catch all client relevant emitted events.
   *
   * The listeners passed in will **always** be the first ones
   * to get the emitted event before other registered listeners.
   */
  on?: Partial<{ [event in Event]: EventListener<event> }>;

  /**
   * Called when the server has sent a connection open message. If not specified,
   * the client will automatically emit a connection init message without a payload.
   */
  onOpen?: (payload?: OpenPayload) => Promise<InitPayload> | InitPayload;
}

export function createClient<OpenPayload, InitPayload, AckPayload>(
  options: ClientOptions<OpenPayload, InitPayload, AckPayload>
) {
  const {
    url,
    onOpen,
    lazy = true,
    onNonLazyError = console.error,
    lazyCloseTimeout = 0,
    keepAlive = 0,
    retryAttempts = 5,
    retryWait = randomisedExponentialBackoff,
    on,
  } = options;

  // Messages start at int 1
  // TODO: small ints are packed as 1 byte in msgpack.
  // rotate around message ids once they are not in use anymore to conserve bandwidth
  let id = 1;
  function generateID() {
    return id++;
  }

  let ws;
  if (typeof WebSocket !== "undefined") {
    ws = WebSocket;
    // @ts-expect-error: Deno doesn't support global
  } else if (typeof global !== "undefined") {
    ws =
      // @ts-expect-error: Deno doesn't support global
      global.WebSocket ||
      // @ts-expect-error: Support more browsers
      global.MozWebSocket;
  } else if (typeof window !== "undefined") {
    ws =
      // @ts-expect-error: Deno doesn't support websocket on window
      window.WebSocket ||
      // @ts-expect-error: Support more browsers
      window.MozWebSocket;
  }
  if (!ws) throw new Error("WebSocket implementation missing.");
  const WebSocketImpl = ws;

  // websocket status emitter, subscriptions are handled differently
  const emitter = (() => {
    // Listener used internally to route messages to the right subscriptions
    const message = (() => {
      const listeners: { [key: number]: EventMessageListener } = {};
      return {
        on(id: number, listener: EventMessageListener) {
          listeners[id] = listener;
          return () => {
            delete listeners[id];
          };
        },
        emit(message: Message) {
          const type = message[0];
          if (
            type === MessageType.Subscribe ||
            type === MessageType.Next ||
            type === MessageType.Error ||
            type === MessageType.Complete
          ) {
            listeners[message[1]]?.(message);
          }
        },
      };
    })();

    const listeners: { [event in Event]: EventListener<event>[] } = {
      connecting: on?.connecting ? [on.connecting] : [],
      opened: on?.opened ? [on.opened] : [],
      connected: on?.connected ? [on.connected] : [],
      acknowledged: on?.acknowledged ? [on.acknowledged] : [],
      message: on?.message ? [message.emit, on.message] : [message.emit],
      closed: on?.closed ? [on.closed] : [],
      error: on?.error ? [on.error] : [],
      ping: on?.ping ? [on.ping] : [],
      pong: on?.pong ? [on.pong] : [],
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

  // invokes the callback either when an error or closed event is emitted,
  // first one that gets called prevails, other emissions are ignored
  function errorOrClosed(cb: (errOrEvent: unknown) => void) {
    const listening = [
      // errors are fatal and more critical than close events, throw them first
      emitter.on("error", (err) => {
        listening.forEach((unlisten) => unlisten());
        cb(err);
      }),
      // closes can be graceful and not fatal, throw them second (if error didnt throw)
      emitter.on("closed", (event) => {
        listening.forEach((unlisten) => unlisten());
        cb(event);
      }),
    ];
  }

  type Connected = [socket: WebSocket, throwOnClose: Promise<void>];
  let connecting: Promise<Connected> | undefined,
    locks = 0,
    retrying = false,
    retries = 0,
    disposed = false;

  async function connect(): Promise<
    [
      socket: WebSocket,
      release: () => void,
      waitForReleaseOrThrowOnClose: Promise<void>
    ]
  > {
    const [socket, throwOnClose] = await (connecting ??
      (connecting = new Promise<Connected>((connected, denied) =>
        (async () => {
          if (retrying) {
            await retryWait(retries);

            // subscriptions might complete while waiting for retry
            if (!locks) {
              connecting = undefined;
              return denied({ code: 1000, reason: "All Subscriptions Gone" });
            }

            retries++;
          }

          emitter.emit("connecting");
          const socket = new WebSocketImpl(
            typeof url === "function" ? await url() : url,
            [SUBBY_WS_PROTOCOL]
          ) as WebSocket;

          socket.binaryType = "arraybuffer";

          let connectionAckTimeout: ReturnType<typeof setTimeout>,
            queuedPing: ReturnType<typeof setTimeout>;

          /**
           * Function to send a ping message to the server.
           * No-op if keepAlive is 0
           */
          function enqueuePing() {
            if (isFinite(keepAlive) && keepAlive > 0) {
              clearTimeout(queuedPing); // in case where a pong was received before a ping (this is valid behaviour)
              queuedPing = setTimeout(() => {
                if (socket.readyState === WebSocketImpl.OPEN) {
                  socket.send(packMessage([MessageType.Ping]));
                  emitter.emit("ping", false, undefined);
                }
              }, keepAlive);
            }
          }

          errorOrClosed((errOrEvent) => {
            connecting = undefined;
            clearTimeout(connectionAckTimeout);
            clearTimeout(queuedPing);
            denied(errOrEvent);

            if (isLikeCloseEvent(errOrEvent) && errOrEvent.code === 4499) {
              socket.close(4499, "Terminated"); // close event is artificial and emitted manually, see `Client.terminate()` below
              socket.onerror = null;
              socket.onclose = null;
            }
          });

          socket.onerror = (err) => emitter.emit("error", err);
          socket.onclose = (event) => emitter.emit("closed", event);

          socket.onopen = () => {
            try {
              emitter.emit("connected", socket);

              // We don't actually do anything here, because we rely on the server
              // sending us an 'open' message first.

              enqueuePing(); // enqueue ping (noop if disabled)
            } catch (err) {
              emitter.emit("error", err);
              socket.close(
                CloseCode.InternalClientError,
                limitCloseReason(
                  err instanceof Error ? err.message : new Error(err).message,
                  "Internal client error"
                )
              );
            }
          };

          // We wait for the open -> init -> ack handshake to complete.
          let acknowledged = false;
          let opened = false;
          socket.onmessage = async ({ data }) => {
            try {
              const message = unpackMessage(data);
              emitter.emit("message", message);

              // Always respond to ping/pong events
              if (
                message[0] === MessageType.Ping ||
                message[0] === MessageType.Pong
              ) {
                const ev = message[0] === MessageType.Ping ? "ping" : "pong";
                emitter.emit(ev, true, message[1]); // received
                if (message[0] === MessageType.Pong) {
                  enqueuePing(); // enqueue next ping (noop if disabled)
                } else {
                  // respond with pong on ping
                  const pong: PongMessage = [MessageType.Pong];

                  if (message[1]) {
                    pong[1] = message[1];
                  }

                  socket.send(packMessage(pong));
                  emitter.emit("pong", false, message[1]);
                }
                return; // ping and pongs can be received whenever
              }

              if (acknowledged) return; // already connected and acknowledged

              // Check open message
              if (!opened) {
                if (message[0] === MessageType.ConnectionOpen) {
                  opened = true;
                  emitter.emit("opened", socket, message[1]);

                  // Default is no payload
                  const initPayload = await options.onOpen?.(
                    message[1] as OpenPayload
                  );

                  // Always send init message
                  socket.send(
                    packMessage([MessageType.ConnectionInit, initPayload])
                  );
                } else {
                  throw new Error(`First message must be open message`);
                }

                return;
              }

              // We must have an ack message as second
              if (message[0] !== MessageType.ConnectionAck) {
                throw new Error(`Second message must be ack`);
              }

              clearTimeout(connectionAckTimeout);
              acknowledged = true;
              emitter.emit("acknowledged", socket, message[1]);

              retrying = false; // future lazy connects are not retries
              retries = 0; // reset the retries on connect
              connected([
                socket,
                new Promise<void>((_, reject) => errorOrClosed(reject)),
              ]);
            } catch (err) {
              socket.onmessage = null; // stop reading messages as soon as reading breaks once
              emitter.emit("error", err);
              socket.close(
                CloseCode.BadResponse,
                limitCloseReason(
                  err instanceof Error ? err.message : new Error(err).message,
                  "Bad response"
                )
              );
            }
          };
        })()
      )));

    // if the provided socket is in a closing state, wait for the throw on close
    if (socket.readyState === WebSocketImpl.CLOSING) await throwOnClose;

    let release = () => {
      // releases this connection
    };
    const released = new Promise<void>((resolve) => (release = resolve));

    return [
      socket,
      release,
      Promise.race([
        // wait for
        released.then(() => {
          if (!locks) {
            // and if no more locks are present, complete the connection
            const complete = () => socket.close(1000, "Normal Closure");
            if (isFinite(lazyCloseTimeout) && lazyCloseTimeout > 0) {
              // if the keepalive is set, allow for the specified calmdown time and
              // then complete. but only if no lock got created in the meantime and
              // if the socket is still open
              setTimeout(() => {
                if (!locks && socket.readyState === WebSocketImpl.OPEN)
                  complete();
              }, lazyCloseTimeout);
            } else {
              // otherwise complete immediately
              complete();
            }
          }
        }),
        // or
        throwOnClose,
      ]),
    ];
  }

  /**
   * Checks the `connect` problem and evaluates if the client should retry.
   */
  function shouldRetryConnectOrThrow(errOrCloseEvent: unknown): boolean {
    // some close codes are worth reporting immediately
    if (
      isLikeCloseEvent(errOrCloseEvent) &&
      (isFatalInternalCloseCode(errOrCloseEvent.code) ||
        [
          CloseCode.InternalServerError,
          CloseCode.InternalClientError,
          CloseCode.BadRequest,
          CloseCode.BadResponse,
          CloseCode.Unauthorized,
          // CloseCode.Forbidden, might grant access out after retry
          // CloseCode.SubprotocolNotAcceptable,
          // CloseCode.ConnectionInitialisationTimeout, might not time out after retry
          // CloseCode.ConnectionAcknowledgementTimeout, might not time out after retry
          // CloseCode.SubscriberAlreadyExists,
          // CloseCode.TooManyInitialisationRequests,
          // 4499, // Terminated, probably because the socket froze, we want to retry
        ].includes(errOrCloseEvent.code))
    )
      throw errOrCloseEvent;

    // client was disposed, no retries should proceed regardless
    if (disposed) return false;

    // normal closure (possibly all subscriptions have completed)
    // if no locks were acquired in the meantime, shouldnt try again
    if (isLikeCloseEvent(errOrCloseEvent) && errOrCloseEvent.code === 1000)
      return locks > 0;

    // retries are not allowed or we tried to many times, report error
    if (!retryAttempts || retries >= retryAttempts) throw errOrCloseEvent;

    // looks good, start retrying
    return (retrying = true);
  }

  // in non-lazy (hot?) mode always hold one connection lock to persist the socket
  if (!lazy) {
    (async () => {
      locks++;
      for (;;) {
        try {
          const [, , throwOnClose] = await connect();
          await throwOnClose; // will always throw because releaser is not used
        } catch (errOrCloseEvent) {
          try {
            if (!shouldRetryConnectOrThrow(errOrCloseEvent)) return;
          } catch (errOrCloseEvent) {
            // report thrown error, no further retries
            return onNonLazyError?.(errOrCloseEvent);
          }
        }
      }
    })();
  }

  return {
    on: emitter.on,
    subscribe<Name extends string, Params = unknown, Result = unknown>(
      method: Name,
      params: Params,
      sink: Sink<Result>
    ) {
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
              switch (message[0]) {
                case MessageType.Next: {
                  sink.next(message[2] as Result);
                  return;
                }
                case MessageType.Error: {
                  (errored = true), (done = true);
                  sink.error(message[2], message[3]);
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
              packMessage<MessageType.Subscribe>([
                MessageType.Subscribe,
                id,
                method,
                params,
              ])
            );

            releaser = () => {
              if (!done && socket.readyState === WebSocketImpl.OPEN)
                // if not completed already and socket is open, send complete message to server on release
                socket.send(
                  packMessage<MessageType.Complete>([MessageType.Complete, id])
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

    async dispose() {
      disposed = true;
      if (connecting) {
        // if there is a connection, close it
        const [socket] = await connecting;
        socket.close(1000, "Normal Closure");
      }
    },
  };
}

function isFatalInternalCloseCode(code: number): boolean {
  if (
    [
      1000, // Normal Closure is not an erroneous close code
      1001, // Going Away
      1006, // Abnormal Closure
      1005, // No Status Received
      1012, // Service Restart
      1013, // Try Again Later
      1013, // Bad Gateway
    ].includes(code)
  )
    return false;
  // all other internal errors are fatal
  return code >= 1000 && code <= 1999;
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

/** Minimal close event interface required by the lib for error and socket close handling. */
interface LikeCloseEvent {
  /** Returns the WebSocket connection close code provided by the server. */
  readonly code: number;
  /** Returns the WebSocket connection close reason provided by the server. */
  readonly reason: string;
}

function isLikeCloseEvent(val: unknown): val is LikeCloseEvent {
  return isObject(val) && "code" in val && "reason" in val;
}
