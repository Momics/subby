# subby
A tiny (deno) websocket server and (deno/node/browser) client that allows RPC and subscriptions. Inspired by graphql-ws. Uses msgpackr for serialization (binary encoded).


## Important
The server is currently only compatible with Deno. Only the client is compatible with both Deno and Node. You can build a Node module using the build.node.ts script with Deno. Since the server is incompatible with Node, the NPM package won't export the server.

To use the /examples in Deno, make sure you pass an import map:

```bash
deno run --import-map=./examples/import_map.json --allow-net --allow-read examples/server.ts
deno run --import-map=./examples/import_map.json --allow-net --allow-read examples/client.ts
```

## Using AsyncIterators on the client
See the client example for a helper function to use async iterators.