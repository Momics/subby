export function extendedTypeof(
  val: unknown
):
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "symbol"
  | "undefined"
  | "object"
  | "function"
  | "array"
  | "null" {
  if (val === null) {
    return "null";
  }
  if (Array.isArray(val)) {
    return "array";
  }
  return typeof val;
}

export function isObject(val: unknown): val is Record<PropertyKey, unknown> {
  return extendedTypeof(val) === "object";
}

export function isAsyncIterable<T = unknown>(
  val: unknown
): val is AsyncIterable<T> {
  return typeof Object(val)[Symbol.asyncIterator] === "function";
}

export function isAsyncGenerator<T = unknown>(
  val: unknown
): val is AsyncGenerator<T> {
  return (
    isObject(val) &&
    typeof Object(val)[Symbol.asyncIterator] === "function" &&
    typeof val.return === "function"
    // for lazy ones, we only need the return anyway
    // typeof val.throw === 'function' &&
    // typeof val.next === 'function'
  );
}
