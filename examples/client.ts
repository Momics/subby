import { createClient } from "../client.ts";

const client = createClient({
  url: "ws://localhost:4004",
  // lazyCloseTimeout: 2000,

  handleOpen(openPayload) {
    console.log("onOpen", openPayload);

    return {
      init: "true",
    };
  },

  on: {
    connecting: () => {
      console.log("connecting");
    },
    connected: () => {
      console.log("connected");
    },
    opened: (p) => {
      console.log("opened", p);
    },
    acknowledged: () => {
      console.log("acknowledged");
    },
    closed(e) {
      console.log("closed", e.code, e.reason);
    },
    message(msg) {
      console.log("message", msg);
    },
  },
});

const start = performance.now();
client.warmup().then(() => {
  const end = performance.now();
  console.log(`warmup took ${end - start}ms`);
});

setTimeout(() => {
  client.subscribe(
    "test",
    { test: true },
    {
      complete() {
        console.log("complete");
      },
      error() {
        console.log("error");
      },
      next(value) {
        console.log("next", value);
      },
    }
  );
}, 5000);
