function buildContextLabel(context) {
  if (!context) {
    return "[Webhook]";
  }

  // Sanitize context to prevent format string misuse in log calls
  const safeContext = String(context).replace(/%/g, "%%");
  return `[Webhook:${safeContext}]`;
}

function getStatusCode(error) {
  const match = /(\d{3}) status code/.exec(error?.message ?? "");
  return match ? Number(match[1]) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendWebhookMessage(
  webhook,
  payload,
  { context = null, onError = null, retries = 2, retryDelayMs = 500 } = {}
) {
  if (typeof webhook?.setThrowErrors === "function") {
    webhook.setThrowErrors(false);
  }

  const contextLabel = buildContextLabel(context);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await webhook.send(payload);
      return true;
    } catch (error) {
      const statusCode = getStatusCode(error);
      const isTransient = statusCode === null || statusCode >= 500;
      const hasAttemptsLeft = attempt < retries;

      if (isTransient && hasAttemptsLeft) {
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }

      const message = error?.message ?? String(error);
      const response = error?.response ?? null;
      const formattedResponse =
        response && typeof response !== "string"
          ? JSON.stringify(response)
          : response;

      if (formattedResponse) {
        console.error(
          `${contextLabel} Failed to send webhook: ${message}. Response: ${formattedResponse}`
        );
      } else {
        console.error(`${contextLabel} Failed to send webhook: ${message}`);
      }

      if (typeof onError === "function") {
        try {
          onError(error);
        } catch (callbackError) {
          // Use separate arguments to avoid format-string interpretation of contextLabel
          console.error(contextLabel, "Error while executing webhook error handler:", callbackError);
        }
      }

      return false;
    }
  }

  return false;
}
