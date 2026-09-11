/**
 * Client-disconnect + timeout abort for upstream fetches.
 * Abandoned SSE streams must stop consuming provider tokens.
 */
export function createUpstreamAbort({ req, res, requestId, model, protocol, provider, timeoutMs = 120000 }) {
  const ac = new AbortController();
  const timeoutId = setTimeout(
    () => ac.abort(new Error(`Upstream timeout after ${timeoutMs}ms`)),
    timeoutMs
  );
  const onClientClose = () => {
    if (!ac.signal.aborted) {
      console.error(
        JSON.stringify({
          type: "client_disconnect",
          requestId,
          model,
          protocol,
          provider,
        })
      );
      ac.abort(new Error("Client disconnected"));
    }
  };
  req.on("close", onClientClose);
  res.on("close", onClientClose);
  return {
    signal: ac.signal,
    isAborted: () => ac.signal.aborted,
    cleanup() {
      clearTimeout(timeoutId);
      req.off("close", onClientClose);
      res.off("close", onClientClose);
    },
  };
}
