import { HTTP } from "./deps.ts";
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
} from "./common.ts";
import { isAsyncGenerator, isAsyncIterable } from "./utils.ts";

export type Method<State, Params = unknown, Result = unknown> = (
  params: Params,
  ctx: Context<State>
) =>
  | Promise<Result | AsyncGenerator<Result> | AsyncIterable<Result>>
  | Result
  | AsyncGenerator<Result>
  | AsyncIterable<Result>;

export interface Context<State = any, InitPayload = any> {
  readonly socket: WebSocket;
  readonly req: Request;
  readonly connInfo?: HTTP.ConnInfo;

  readonly opened: boolean;
  readonly initiated: boolean;
  readonly acknowledged: boolean;

  readonly initPayload?: Readonly<InitPayload>;

  readonly subscriptions: Record<
    number,
    AsyncGenerator<unknown> | AsyncIterable<unknown> | null
  >;

  state: State;
}

export interface ServerOptions<State, InitPayload> {
  /** All callable methods */
  methods?: { [key: string]: Method<State> };

  /** Time in ms */
  connectionInitWaitTimeout?: number;

  /** The initial state of a connection */
  initState: (req: Request, connInfo?: HTTP.ConnInfo) => Promise<State> | State;

  /** A function to decline a connection and/or set context */
  onOpen?: <OpenPayload>(
    ctx: Context<State, InitPayload>
  ) => Promise<OpenPayload | void> | OpenPayload | void;

  /** Function called when the connection is just about to be acknowledged */
  onAck?: <AckPayload>(
    ctx: Context<State, InitPayload>
  ) => Promise<AckPayload | void> | AckPayload | void;

  /** Triggered on close */
  onClose?: (
    ctx: Context<State, InitPayload>,
    code: number,
    reason: string
  ) => void;
}

export function createServer<State, InitPayload>(
  options: ServerOptions<State, InitPayload>
) {
  const connectionInitWaitTimeout = options.connectionInitWaitTimeout || 5000;

  return {
    /**
     * Handles incoming HTTP request and upgrades to Subby websocket
     * @param req
     * @param connInfo
     * @returns
     */
    async upgradeRequest(req: Request, connInfo?: HTTP.ConnInfo) {
      if (!req.headers.get("upgrade")) {
        throw new Error(`Request is not trying to upgrade`);
      }

      let response, socket: WebSocket;
      try {
        ({ response, socket } = Deno.upgradeWebSocket(req, {
          protocol: SUBBY_WS_PROTOCOL,
        }));

        // We do only binary with msgpack
        socket.binaryType = "arraybuffer";
      } catch {
        return new Response(null, { status: HTTP.Status.BadRequest });
      }

      const state = await options.initState(req, connInfo);
      const ctx: Context<State> = {
        socket,
        req,
        connInfo,

        opened: false,
        initiated: false,
        acknowledged: false,

        subscriptions: {},
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
        const openPayload = await options.onOpen?.(ctx);

        // @ts-expect-error: I can write
        ctx.opened = true;

        socket.send(
          packMessage({
            type: MessageType.ConnectionOpen,
            payload: openPayload,
          })
        );
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
          const view = new Uint8Array(data);
          message = unpackMessage(view);
        } catch (err) {
          return socket.close(CloseCode.BadRequest, "Invalid message received");
        }

        switch (message.type) {
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
            ctx.initPayload = message.payload;

            const ackPayload = await options.onAck?.(ctx);
            if (ackPayload === false) {
              return socket.close(CloseCode.Forbidden, "Forbidden");
            }

            // Always send an ack
            socket.send(
              packMessage({
                type: MessageType.ConnectionAck,
                payload: ackPayload,
              })
            );

            // @ts-expect-error: I can write
            ctx.acknowledged = true;
            return;
          }

          case MessageType.Subscribe: {
            if (!ctx.acknowledged) {
              return socket.close(CloseCode.Unauthorized, "Unauthorized");
            }

            const { id } = message;

            if (id in ctx.subscriptions) {
              return socket.close(
                CloseCode.ProtocolError,
                "Already subscribed"
              );
            }

            // if this turns out to be a streaming operation, the subscription value
            // will change to an `AsyncIterable`, otherwise it will stay as is
            ctx.subscriptions[id] = null;

            const emit = {
              next: async (value: NextMessage["value"]) => {
                const nextMessage: NextMessage = {
                  id,
                  type: MessageType.Next,
                  value,
                };

                await socket.send(packMessage<MessageType.Next>(nextMessage));
              },
              error: async (code: string, data?: unknown) => {
                const errorMessage: ErrorMessage = {
                  id,
                  type: MessageType.Error,
                  code,
                  data,
                };

                await socket.send(packMessage<MessageType.Error>(errorMessage));
              },
              /**
               * Emitter used to hang up a call
               * @param notifyClient
               */
              complete: async (notifyClient: boolean) => {
                if (!notifyClient) return;

                const completeMessage: CompleteMessage = {
                  id,
                  type: MessageType.Complete,
                };

                await socket.send(
                  packMessage<MessageType.Complete>(completeMessage)
                );
              },
            };

            // Check if the method is valid
            const method = options.methods?.[message.method];

            if (!method) {
              emit.error("NotFound", {
                message: "Method not found",
              });
              return;
            }

            try {
              const methodResult = await method(message.params, ctx);

              if (isAsyncIterable(methodResult)) {
                /** multiple emitted results */
                ctx.subscriptions[id] = methodResult;

                if (!(id in ctx.subscriptions)) {
                  // subscription was completed/canceled before the operation settled
                  if (isAsyncGenerator(methodResult))
                    methodResult.return(undefined);
                } else {
                  ctx.subscriptions[id] = methodResult;
                  for await (const result of methodResult) {
                    await emit.next(result);
                  }
                }
              } else {
                /** single emitted result */
                // if the client completed the subscription before the single result
                // became available, he effectively canceled it and no data should be sent
                if (id in ctx.subscriptions) await emit.next(methodResult);
              }

              // lack of subscription at this point indicates that the client
              // completed the subscription, he doesnt need to be reminded
              await emit.complete(id in ctx.subscriptions);
            } catch (err) {
              const code = err.code || "InternalError";
              const data = err.data || { message: err.message };
              await emit.error(code, data);
            } finally {
              delete ctx.subscriptions[id];
            }

            return;
          }

          case MessageType.Complete: {
            const subscription = ctx.subscriptions[message.id];
            if (isAsyncGenerator(subscription))
              await subscription.return(undefined);
            delete ctx.subscriptions[message.id]; // deleting the subscription means no further activity should take place
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
