import { createClient } from "../client.ts";

const client = createClient({
  url: "ws://localhost:4004",
  handleOpen() {
    return {
      init: "true",
    };
  },
});

function subscribe<Name extends string, Params = unknown, Result = unknown>(
  name: Name,
  params: Params
): AsyncGenerator<Result> {
  let deferred: {
    resolve: (done: boolean) => void;
    reject: (err: unknown) => void;
  } | null = null;
  const pending: Result[] = [];
  let throwMe: unknown = null,
    done = false;

  const dispose = client.subscribe(name, params, {
    next: (data: Result) => {
      pending.push(data);
      deferred?.resolve(false);
    },
    error: (err) => {
      throwMe = err;
      deferred?.reject(throwMe);
    },
    complete: () => {
      done = true;
      deferred?.resolve(true);
    },
  });

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (done) return { done: true, value: undefined };
      if (throwMe) throw throwMe;
      if (pending.length) return { value: pending.shift()! };
      return (await new Promise<boolean>(
        (resolve, reject) => (deferred = { resolve, reject })
      ))
        ? { done: true, value: undefined }
        : { value: pending.shift()! };
    },
    async throw(err) {
      throw err;
    },
    async return() {
      dispose();
      return { done: true, value: undefined };
    },
  };
}

(async () => {
  const subscription = subscribe("testSubscription", {
    test: true,
  });
  // subscription.return() to dispose

  for await (const result of subscription) {
    // next = result = { data: { greetings: 5x } }
    console.log(result);
  }
  // complete
  console.log("complete");
})();
