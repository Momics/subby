import { createServer } from "../server.ts";
import {
  serve,
  Status,
  ConnInfo,
} from "https://deno.land/std@0.152.0/http/mod.ts";

interface InitPayload {
  init: "true";
}

interface OpenPayload {
  connected: true;
}

interface State {
  test?: boolean;
}

// Server uses a three way handshake to establish a connection
// Server => Client (ack)
// Client => Server (init)
// Server => Client (open)
// All handshakes messages can contain a payload
const server = createServer<State, OpenPayload, InitPayload, undefined>({
  connectionInitWaitTimeout: 2000,
  methods: {
    testRequest: async (params, ctx) => {
      const res = await fetch("https://momics.eu");

      return {
        test: true,
        status: res.status,
        text: res.statusText,
      };
    },
    testSubscription: async function* (params, ctx) {
      console.log("test");
      yield { test: true };
      yield { test: true };
      yield { test: true };
    },
  },
  handleInit({ initPayload }) {
    console.log("handleInit", initPayload);

    // Do something like auth here
    if (initPayload?.init !== "true") {
      // Deny the connection (throws Forbidden)
      return false;
    }
  },
  handleOpen(ctx) {
    return {
      connected: true,
    };
  },
  onClose(ctx, code, reason) {
    console.log("onClose", code, reason);
  },
  onMessageSent() {
    console.log("onMessageSent");
  },
  onMessageReceived() {
    console.log("onMessageReceived");
  },
  onPing() {
    console.log("onPing");
  },
  onPong() {
    console.log("onPong");
  },
});

/**
 * Main request handler for the application
 *
 * @param req
 * @returns
 */
async function handleRequest(req: Request, connInfo?: ConnInfo) {
  const res = await server.upgrade(req, connInfo);

  return res;
}

/**
 * Serve HTTP
 */
await serve(handleRequest, {
  port: 4004,
  onListen: ({ hostname, port }) => {
    console.log(`Started server on ${hostname}:${port}`);
  },
});
