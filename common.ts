import { pack, unpack } from "msgpackr";

export const SUBBY_WS_PROTOCOL = "subby-ws";

export class SubbyError extends Error {
  constructor(public code: string, public data?: unknown) {
    super(code);
  }
}

/**
 * All Noat close codes emitted by the server
 */
export enum CloseCode {
  /** Tried sending before socket was open */
  SocketNotOpen = 4423,
  TooManyInitializationRequests = 4429,
  ConnectionInitialisationTimeout = 4408,
  ConnectionAcknowledgementTimeout = 4504,
  ProtocolError = 1002,

  InternalServerError = 4500,
  InternalClientError = 4005,
  BadRequest = 4400,
  BadResponse = 4004,
  NotFound = 4404,
  Unauthorized = 4401,
  Forbidden = 4403,
  AuthTimeout = 4504,
}

/**
 * All message types
 *
 * It's not necessary to send known keys with every message so messages travel
 * over the wire as arrays to save bandwidth. Since messages are binary encoded
 * anyway, this doesn't sacrifice readability of messages in any way.
 *
 * Types are deliberately small integers which are packed as smaller
 * ints on the wire by msgpack.
 *
 * NOTE: Ping/Pong is exluded since it is handled by Deno websocket server internally.
 */
export enum MessageType {
  ConnectionOpen = 0, // server -> client
  ConnectionInit = 1, // client -> server
  ConnectionAck = 2, // server -> client

  Subscribe = 3, // client -> server
  Complete = 4, // bidi
  Next = 5, // server -> client
  Error = 6, // server -> client

  Ping = 7, // bidi
  Pong = 8, // bidi
}

/**
 * Sent by the client in response to an ConnectionAckMessage
 */
export type ConnectionOpenMessage = [
  type: MessageType.ConnectionOpen,
  payload?: unknown
];

/**
 * Sent by the client in response to an ConnectionAckMessage
 */
export type ConnectionInitMessage = [
  type: MessageType.ConnectionInit,
  payload?: unknown
];

/**
 * Sent by the server to the client to acknowledge a connection
 */
export type ConnectionAckMessage = [
  type: MessageType.ConnectionAck,
  payload?: unknown
];

/**
 * Sent by the client to the server to subscribe to a method.
 * Everything in Noat is a subscription, even request / response.
 */
export type SubscribeMessage = [
  type: MessageType.Subscribe,
  id: number,
  method: string,
  params?: unknown
];

/**
 * Sent to terminate a subscription.
 */
export type CompleteMessage = [type: MessageType.Complete, id: number];

/**
 * The next value in a subscription.
 */
export type NextMessage = [type: MessageType.Next, id: number, value: unknown];

/**
 * Sent by server when a subscription results in an error.
 * This automatically terminates the subscription.
 */
export type ErrorMessage = [
  type: MessageType.Error,
  id: number,
  code: string,
  payload?: unknown
];

/**
 * Ping can be done by either side.
 */
export type PingMessage = [type: MessageType.Ping, payload?: unknown];

/**
 * Sent in response to a ping message. Will contain the payload of the ping message.
 */
export type PongMessage = [type: MessageType.Pong, payload?: unknown];

export type Message<T extends MessageType = MessageType> =
  T extends MessageType.ConnectionOpen
    ? ConnectionOpenMessage
    : T extends MessageType.ConnectionAck
    ? ConnectionAckMessage
    : T extends MessageType.ConnectionInit
    ? ConnectionInitMessage
    : T extends MessageType.Subscribe
    ? SubscribeMessage
    : T extends MessageType.Complete
    ? CompleteMessage
    : T extends MessageType.Next
    ? NextMessage
    : T extends MessageType.Error
    ? ErrorMessage
    : T extends MessageType.Ping
    ? PingMessage
    : T extends MessageType.Pong
    ? PongMessage
    : never;

/**
 * Validates and unpacks the provided message
 * @param val
 */
export function unpackMessage(data: unknown): Message {
  if (!(data instanceof ArrayBuffer)) {
    throw new Error(`Message must be an ArrayBuffer`);
  }

  const view = new Uint8Array(data);
  const msg = unpack(view);
  const type = msg[0] as MessageType;

  if (typeof type !== "number") {
    throw new Error(`Message type must be a number`);
  }

  switch (type) {
    case MessageType.ConnectionOpen: {
      if (msg.length !== 1 && msg.length !== 2) {
        throw new Error(`Open message must have 1 or 2 elements`);
      }

      return msg as ConnectionAckMessage;
    }
    case MessageType.ConnectionAck: {
      if (msg.length !== 1 && msg.length !== 2) {
        throw new Error(`Ack message must have 1 or 2 elements`);
      }

      return msg as ConnectionAckMessage;
    }
    case MessageType.ConnectionInit: {
      if (msg.length !== 1 && msg.length !== 2) {
        throw new Error(`Init message must have 1 or 2 elements`);
      }

      return msg as ConnectionInitMessage;
    }
    case MessageType.Subscribe: {
      if (msg.length !== 3 && msg.length !== 4) {
        throw new Error(`Subscribe message must have 3 or 4 elements`);
      }

      if (typeof msg[1] !== "number") {
        throw new Error(
          `Subscribe message must have a number as the second element`
        );
      }

      if (typeof msg[2] !== "string") {
        throw new Error(
          `Subscribe message must have a string as the third element`
        );
      }

      return msg as SubscribeMessage;
    }
    case MessageType.Complete: {
      if (msg.length !== 2) {
        throw new Error(`Unsubscribe message must have 2 elements`);
      }

      if (typeof msg[1] !== "number") {
        throw new Error(
          `Unsubscribe message must have a number as the second element`
        );
      }

      return msg as CompleteMessage;
    }
    case MessageType.Next: {
      if (msg.length !== 3 && msg.length !== 4) {
        throw new Error(`Next message must have 3 or 4 elements`);
      }

      if (typeof msg[1] !== "number") {
        throw new Error(
          `Next message must have a number as the second element`
        );
      }

      return msg as NextMessage;
    }
    case MessageType.Error: {
      if (msg.length !== 3) {
        throw new Error(`Error message must have 3 elements`);
      }

      if (typeof msg[1] !== "number") {
        throw new Error(
          `Error message must have a number as the second element`
        );
      }

      if (typeof msg[2] !== "string") {
        throw new Error(
          `Error message must have a string as the second element`
        );
      }

      return msg as ErrorMessage;
    }
    case MessageType.Ping: {
      if (msg.length !== 1 && msg.length !== 2) {
        throw new Error(`Ping message must have 1 or 2 elements`);
      }

      return msg as ConnectionAckMessage;
    }
    case MessageType.Pong: {
      if (msg.length !== 1 && msg.length !== 2) {
        throw new Error(`Pong message must have 1 or 2 elements`);
      }

      return msg as ConnectionAckMessage;
    }
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

/**
 * Validates and packs a message into a binary encoded array.
 *
 * NOTE: This packs the message into an array format so that keys can be
 *      discarded, saving a couple of bytes on the wire.
 *
 * @param msg
 * @returns
 */
export function packMessage<T extends MessageType>(
  msg: Message<T>
): Uint8Array {
  switch (msg[0]) {
    case MessageType.ConnectionOpen: {
      return pack(msg);
    }
    case MessageType.ConnectionAck: {
      return pack(msg);
    }
    case MessageType.ConnectionInit: {
      return pack(msg);
    }
    case MessageType.Subscribe: {
      if (typeof msg[1] !== "number") {
        throw new Error(`Subscribe message must have a id key of value number`);
      }

      if (typeof msg[2] !== "string") {
        throw new Error(
          `Subscribe message must have a method key of value string`
        );
      }

      return pack(msg);
    }
    case MessageType.Complete: {
      if (typeof msg[1] !== "number") {
        throw new Error(
          `Unsubscribe message must have a id key of value number`
        );
      }

      return pack(msg);
    }
    case MessageType.Next: {
      if (typeof msg[1] !== "number") {
        throw new Error(`Next message must have a id key of value number`);
      }

      return pack(msg);
    }
    case MessageType.Error: {
      if (typeof msg[1] !== "number") {
        throw new Error(`Error message must have a id key of value number`);
      }

      if (typeof msg[2] !== "string") {
        throw new Error(
          `Error message must have a code key of value string: ${msg[2]}`
        );
      }

      return pack(msg);
    }
    case MessageType.Ping: {
      return pack(msg);
    }
    case MessageType.Pong: {
      return pack(msg);
    }
    default:
      throw new Error(`Unknown message type: ${msg}`);
  }
}

/**
 * A representation of any set of values over any amount of time.
 *
 * @category Common
 */
export interface Sink<T = unknown> {
  /** Next value arriving. */
  next(value: T): void;
  /**
   * An error that has occured. Calling this function "closes" the sink.
   * Besides the errors being `Error` and `readonly GraphQLError[]`, it
   * can also be a `CloseEvent`, but to avoid bundling DOM typings because
   * the client can run in Node env too, you should assert the close event
   * type during implementation.
   */
  error(code: string, payload?: unknown): void;
  /** The sink has completed. This function "closes" the sink. */
  complete(): void;
}
