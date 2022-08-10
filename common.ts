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
 * Includes all message types in Noat
 * Types are deliberately small integers so that msgpack can optimize space.
 *
 * NOTE: Ping/Pong is exluded since it is handled by the Deno websocket.
 */
export enum MessageType {
  ConnectionOpen = 0, // server -> client
  ConnectionInit = 1, // client -> server
  ConnectionAck = 2, // server -> client

  Subscribe = 3, // client -> server
  Complete = 4, // bidi
  Next = 5, // server -> client
  Error = 6, // server -> client
}

/** When traveling over the wire, a message must be Uint8Array */
export type WireMessage = Uint8Array;

/** When unpacked, a wire message must be an array with type as first element */
export type UnpackedWireMessage = [MessageType, ...unknown[]];

/**
 * Sent by the client in response to an ConnectionAckMessage
 */
export interface ConnectionOpenMessage {
  readonly type: MessageType.ConnectionOpen;
  readonly payload?: unknown;
}

/**
 * Sent by the client in response to an ConnectionAckMessage
 */
export interface ConnectionInitMessage {
  readonly type: MessageType.ConnectionInit;
  readonly payload?: unknown;
}

/**
 * Sent by the server to the client to acknowledge a connection
 */
export interface ConnectionAckMessage {
  readonly type: MessageType.ConnectionAck;
  readonly payload?: unknown;
}

/**
 * Sent by the client to the server to subscribe to a method.
 * Everything in Noat is a subscription, even request / response.
 */
export interface SubscribeMessage {
  readonly type: MessageType.Subscribe;
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/**
 * Sent to terminate a subscription.
 */
export interface CompleteMessage {
  readonly type: MessageType.Complete;
  readonly id: number;
}

/**
 * The next value in a subscription.
 */
export interface NextMessage {
  readonly type: MessageType.Next;
  readonly id: number;
  readonly value: unknown;
}

/**
 * Sent by server when a subscription results in an error.
 * This automatically terminates the subscription.
 */
export interface ErrorMessage {
  readonly type: MessageType.Error;
  readonly id: number;
  readonly code: string;
  readonly data?: unknown;
}

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
    : never;

/**
 * Validates and unpacks the provided message
 * @param val
 */
export function unpackMessage(data: unknown): Message {
  if (!(data instanceof Uint8Array)) {
    throw new Error(`Message must be a Uint8Array`);
  }

  const msg = unpack(data);
  const type = msg[0] as MessageType;

  if (typeof type !== "number") {
    throw new Error(`Message type must be a number`);
  }

  switch (type) {
    case MessageType.ConnectionAck: {
      if (msg.length !== 1 && msg.length !== 2) {
        throw new Error(`Ack message must have 1 or 2 elements`);
      }

      if (!(msg[1] instanceof Uint8Array)) {
        throw new Error(
          `Ack message must have a Uint8Array as the second element`
        );
      }

      return {
        type,
        payload: msg[1],
      } as ConnectionAckMessage;
    }
    case MessageType.ConnectionInit: {
      if (msg.length !== 1 && msg.length !== 2) {
        throw new Error(`Init message must have 1 or 2 elements`);
      }

      if (!(msg[1] instanceof Uint8Array)) {
        throw new Error(
          `Init message must have a Uint8Array as the second element`
        );
      }

      if (!(msg[2] instanceof Uint8Array)) {
        throw new Error(
          `Init message must have a Uint8Array as the third element`
        );
      }

      return {
        type,
        payload: msg[1],
      } as ConnectionInitMessage;
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

      return {
        type,
        id: msg[1],
        method: msg[2],
        params: msg[3],
      } as SubscribeMessage;
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

      return {
        type,
        id: msg[1],
      } as CompleteMessage;
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

      return {
        type,
        id: msg[1],
        value: msg[2],
      } as NextMessage;
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

      return {
        type,
        id: msg[1],
        code: msg[2],
        data: msg[3],
      } as ErrorMessage;
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
 * @param message
 * @returns
 */
export function packMessage<T extends MessageType>(
  message: Message<T>
): Uint8Array {
  switch (message.type) {
    case MessageType.ConnectionAck: {
      return pack([message.type, message.payload]);
    }
    case MessageType.ConnectionInit: {
      return pack([message.type, message.payload]);
    }
    case MessageType.Subscribe: {
      if (typeof message.id !== "number") {
        throw new Error(`Subscribe message must have a id key of value number`);
      }

      if (typeof message.method !== "string") {
        throw new Error(
          `Subscribe message must have a method key of value string`
        );
      }

      return pack([message.type, message.id, message.method, message.params]);
    }
    case MessageType.Complete: {
      if (typeof message.id !== "number") {
        throw new Error(
          `Unsubscribe message must have a id key of value number`
        );
      }

      return pack([message.type, message.id]);
    }
    case MessageType.Next: {
      if (typeof message.id !== "number") {
        throw new Error(`Next message must have a id key of value number`);
      }

      return pack([message.type, message.id, message.value]);
    }
    case MessageType.Error: {
      if (typeof message.id !== "number") {
        throw new Error(`Error message must have a id key of value number`);
      }

      if (typeof message.code !== "string") {
        throw new Error(`Error message must have a code key of value string`);
      }

      return pack([message.type, message.id, message.code, message.data]);
    }
    default:
      throw new Error(`Unknown message type: ${message}`);
  }
}
