import {
  packMessage,
  Message,
  MessageType,
  CloseCode,
  unpackMessage,
  NextMessage,
  ErrorMessage,
  CompleteMessage,
  SUBBY_WS_PROTOCOL,
  PongMessage,
} from "./common.ts";
import { isAsyncGenerator, isAsyncIterable } from "./utils.ts";
import { HTTP } from "./deps.ts";

export type Method<State, Params, Result> = (
  params: Params,
  ctx: Context<State>
) =>
  | Promise<Result | AsyncGenerator<Result> | AsyncIterable<Result>>
  | Result
  | AsyncGenerator<Result>
  | AsyncIterable<Result>;

export interface Context<State = any, InitPayload = any> {
  readonly socket: WebSocket;

  readonly opened: boolean;
  readonly initiated: boolean;
  readonly acknowledged: boolean;

  readonly initPayload?: Readonly<InitPayload>;

  readonly subscriptions: Map<
    number,
    AsyncGenerator<unknown> | AsyncIterable<unknown> | null
  >;

  state: State;
}

export interface ServerOptions<State, OpenPayload, InitPayload, AckPayload> {
  /** All callable methods */
  methods?: { [key: string]: Method<State, any, any> };

  /** Time in ms */
  connectionInitWaitTimeout?: number;

  /** Initiate the state of a connection */
  initState?: (
    req: Request,
    connInfo?: HTTP.ConnInfo
  ) => Promise<State> | State;

  /** A function to decline a connection and/or set context */
  handleOpen?: (
    ctx: Context<State, InitPayload>
  ) => Promise<OpenPayload | void> | OpenPayload | void;

  /** Function called when the connection is just about to be acknowledged */
  handleInit?: (
    ctx: Context<State, InitPayload>
  ) => Promise<AckPayload | void | false> | AckPayload | void | false;

  /** Triggered on close */
  onClose?: (
    ctx: Context<State, InitPayload>,
    code: number,
    reason: string
  ) => void;

  /** Fires when a ping has been received */
  onPing?: (ctx: Context<State, InitPayload>, payload?: unknown) => void;

  /** Fires when a pong is received */
  onPong?: (ctx: Context<State, InitPayload>, payload?: unknown) => void;

  /** Fires on all messages sent */
  onMessage?: (message: Message) => void;
}

export function createServer<State, OpenPayload, InitPayload, AckPayload>(
  options: ServerOptions<State, OpenPayload, InitPayload, AckPayload>
) {
  const { connectionInitWaitTimeout = 3_000 } = options;

  return {
    /**
     * Handle Subby messages on a Websocket connection.
     * @important be sure to set socket.binaryType to "arraybuffer"
     *
     * @param socket The websocket to use for the connection
     * @param state
     * @returns
     */
    async upgrade(req: Request, connInfo?: HTTP.ConnInfo) {
      // Check protocol header
      if (req.headers.get("sec-websocket-protocol") !== SUBBY_WS_PROTOCOL) {
        return new Response("Invalid protocol", {
          status: HTTP.Status.BadRequest,
        });
      }

      // Let's attempt to upgrade to websocket, otherwise we return bad request.
      let response, socket: WebSocket;
      try {
        ({ response, socket } = Deno.upgradeWebSocket(req, {
          protocol: SUBBY_WS_PROTOCOL,
        }));
        socket.binaryType = "arraybuffer";
      } catch {
        return new Response(null, { status: HTTP.Status.BadRequest });
      }

      if (socket.binaryType && socket.binaryType !== "arraybuffer") {
        throw new Error(`socket.binaryType must be set to "arraybuffer"`);
      }

      const state = (await options.initState?.(req, connInfo)) || ({} as State);

      const ctx: Context<State, InitPayload> = {
        socket,
        opened: false,
        initiated: false,
        acknowledged: false,
        subscriptions: new Map(),
        state,
      };

      // kick the client off (close socket) if the connection has
      // not been initialised after the specified wait timeout
      const connectionInitWait =
        connectionInitWaitTimeout > 0 && isFinite(connectionInitWaitTimeout)
          ? setTimeout(() => {
              if (!ctx.initiated)
                socket.close(
                  CloseCode.ConnectionInitialisationTimeout,
                  "Connection initialisation timeout"
                );
            }, connectionInitWaitTimeout)
          : null;

      socket.onopen = async () => {
        // As soon as the connection opens, we emit the connection open message
        // if configured. Note that this means we have another 'opened' state
        // in case the onOpen function returns a promise.
        const openPayload = await options.handleOpen?.(ctx);

        // @ts-expect-error: I can write
        ctx.opened = true;

        socket.send(packMessage([MessageType.ConnectionOpen, openPayload]));
      };

      socket.onmessage = async ({ data }: MessageEvent<ArrayBuffer>) => {
        // In case options.onOpen returns a promise the client must wait
        if (!ctx.opened) {
          return socket.close(
            CloseCode.SocketNotOpen,
            "Wait for the socket open message."
          );
        }

        let message: Message;
        try {
          message = unpackMessage(data);
        } catch (err) {
          return socket.close(CloseCode.BadRequest, "Invalid message received");
        }

        switch (message[0]) {
          case MessageType.ConnectionInit: {
            if (ctx.initiated) {
              return socket.close(
                CloseCode.ProtocolError,
                "Connection already initiated"
              );
            }

            // @ts-expect-error: I can write
            ctx.initiated = true;

            // @ts-expect-error: I can write
            ctx.initPayload = message[1];

            const ackPayload = await options.handleInit?.(ctx);
            if (ackPayload === false) {
              return socket.close(CloseCode.Forbidden, "Forbidden");
            }

            // Always send an ack
            socket.send(packMessage([MessageType.ConnectionAck, ackPayload]));

            // @ts-expect-error: I can write
            ctx.acknowledged = true;
            return;
          }

          case MessageType.Ping: {
            options.onPing?.(ctx, message[1]);

            const pong: PongMessage = [MessageType.Pong];

            if (message[1]) {
              pong[1] = message[1];
            }

            socket.send(packMessage(pong));
            return;
          }
          case MessageType.Pong: {
            return options.onPong?.(ctx, message[1]);
          }

          case MessageType.Subscribe: {
            if (!ctx.acknowledged) {
              return socket.close(CloseCode.Unauthorized, "Unauthorized");
            }

            const id = message[1];

            if (id in ctx.subscriptions) {
              return socket.close(
                CloseCode.ProtocolError,
                "Already subscribed"
              );
            }

            // if this turns out to be a streaming operation, the subscription value
            // will change to an `AsyncIterable`, otherwise it will stay as is
            ctx.subscriptions.set(id, null);

            const emit = {
              next: async (value: NextMessage[2]) => {
                const nextMessage: NextMessage = [MessageType.Next, id, value];

                await socket.send(packMessage<MessageType.Next>(nextMessage));
              },
              error: async (code: string, payload?: unknown) => {
                const errorMessage: ErrorMessage = [
                  MessageType.Error,
                  id,
                  code,
                  payload,
                ];

                await socket.send(packMessage<MessageType.Error>(errorMessage));
              },
              /**
               * Emitter used to hang up a call
               * @param notifyClient
               */
              complete: async (notifyClient: boolean) => {
                if (!notifyClient) return;

                const completeMessage: CompleteMessage = [
                  MessageType.Complete,
                  id,
                ];

                await socket.send(
                  packMessage<MessageType.Complete>(completeMessage)
                );
              },
            };

            // Check if the method is valid
            const methodName = message[2];
            const method = options.methods?.[methodName];

            if (!method) {
              emit.error("NotFound", {
                message: "Method not found",
              });
              return;
            }

            try {
              const methodResult = await method(message[3], ctx);

              if (isAsyncIterable(methodResult)) {
                /** multiple emitted results */
                ctx.subscriptions.set(id, methodResult);

                if (!ctx.subscriptions.has(id)) {
                  // subscription was completed/canceled before the operation settled
                  if (isAsyncGenerator(methodResult))
                    methodResult.return(undefined);
                } else {
                  ctx.subscriptions.set(id, methodResult);
                  for await (const result of methodResult) {
                    await emit.next(result);
                  }
                }
              } else {
                /** single emitted result */
                // if the client completed the subscription before the single result
                // became available, he effectively canceled it and no data should be sent
                if (ctx.subscriptions.has(id)) await emit.next(methodResult);
              }

              // lack of subscription at this point indicates that the client
              // completed the subscription, he doesnt need to be reminded
              await emit.complete(ctx.subscriptions.has(id));
            } catch (err) {
              const code = err.code || "InternalError";
              const data = err.data || { message: err.message };
              await emit.error(code, data);
            } finally {
              ctx.subscriptions.delete(id);
            }

            return;
          }

          case MessageType.Complete: {
            const id = message[1];
            const subscription = ctx.subscriptions.get(id);
            if (isAsyncGenerator(subscription))
              await subscription.return(undefined);
            ctx.subscriptions.delete(id); // deleting the subscription means no further activity should take place
            return;
          }

          default:
            return socket.close(CloseCode.BadRequest, "Invalid message type");
        }
      };

      socket.onclose = async ({ code, reason }) => {
        if (connectionInitWait) clearTimeout(connectionInitWait);

        for (const sub of Object.values(ctx.subscriptions)) {
          if (isAsyncGenerator(sub)) await sub.return(undefined);
        }

        await options.onClose?.(ctx, code, reason);
      };

      return response;
    },
  };
}
