import { createServer } from "../server.ts";
import {
  serve,
  Status,
  ConnInfo,
} from "https://deno.land/std@0.152.0/http/mod.ts";

interface InitPayload {
  init: "true";
}

interface State {
  test?: boolean;
}

const server = createServer<State, InitPayload>({
  connectionInitWaitTimeout: 2000,
  methods: {
    test: async (params, ctx) => {
      const res = await fetch("https://momics.eu");

      return {
        test: true,
        status: res.status,
        text: res.statusText,
      };
    },
  },
  handleInit(ctx) {
    console.log("onAck");

    return {
      ackPayload: true,
    };
  },
  handleOpen(ctx) {
    return {
      signMe: true,
    };
  },
  onClose(ctx, code, reason) {
    console.log("onClose", code, reason);
  },
  onMessage() {
    console.log("onMessage");
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
