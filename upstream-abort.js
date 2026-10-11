/**
 * Client-disconnect + timeout abort for upstream fetches.
 * Abandoned SSE streams must stop consuming provider tokens.
 *
 * reason() distinguishes WHY the abort fired ("client" disconnect vs
 * "timeout" vs null while still connected) so proxy()'s error handler can
 * classify the failure: a timeout is the provider's fault and counts
 * against its circuit breaker + upstream-error metrics, while a client
 * disconnect is the caller's own choice and must not punish the provider.
 */
export function createUpstreamAbort({ req, res, requestId, model, protocol, provider, timeoutMs = 120000 }) {
  const ac = new AbortController();
  let abortReason = null;
  const timeoutId = setTimeout(
    () => {
      abortReason = "timeout";
      ac.abort(new Error(`Upstream timeout after ${timeoutMs}ms`));
    },
    timeoutMs
  );
  const onClientClose = () => {
    if (!ac.signal.aborted) {
      abortReason = "client";
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
    reason: () => abortReason,
    cleanup() {
      clearTimeout(timeoutId);
      req.off("close", onClientClose);
      res.off("close", onClientClose);
    },
  };
}
