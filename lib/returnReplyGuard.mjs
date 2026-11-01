/**
 * "return reply" guard for async route handlers.
 *
 * Many handlers in this codebase finish with `res.send(...)` (or
 * `res.redirect(...)`) without returning it. In an async handler Fastify then
 * sees the promise resolve with `undefined` while the response is still
 * working through the onSend hooks (the Prisma session save in particular),
 * so `reply.sent` is still false and it calls `reply.send()` a second time.
 * That second pass re-runs every onSend hook (a second session write) and then
 * fails in writeHead with ERR_HTTP_HEADERS_SENT, logged as
 * `Reply was already sent, did you forget to "return reply" ...`.
 *
 * Rather than edit every call site, this wraps each async handler: if the
 * handler sent the reply and returned nothing, the wrapper returns the reply,
 * which is what Fastify expects. Callback-style (non-async) handlers are left
 * alone -- they may send later, and returning early would cut them off.
 */

const ASYNC_FN = Object.getPrototypeOf(async function () {}).constructor;

export function wrapAsyncHandler(handler) {
  if (!(handler instanceof ASYNC_FN)) return handler;

  return async function returnReplyGuard(request, reply) {
    let sendCalled = false;
    const originalSend = reply.send;
    reply.send = function (payload) {
      sendCalled = true;
      return originalSend.call(this, payload);
    };

    const result = await handler.call(this, request, reply);
    if (result === undefined && sendCalled) return reply;
    return result;
  };
}

/** Register before any routes so every route added afterwards is covered. */
export function registerReturnReplyGuard(app) {
  app.addHook("onRoute", (routeOptions) => {
    routeOptions.handler = wrapAsyncHandler(routeOptions.handler);
  });
}
