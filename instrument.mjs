import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import dotenv from "dotenv";

dotenv.config();

if (process.env.SENTRY_DSN) {
  const isProduction = process.env.NODE_ENV === "production";

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [
      nodeProfilingIntegration(),
      // Request bodies carry login passwords, reset codes and support
      // messages; never ship them to a third party. Headers and the URL are
      // enough to reproduce an error.
      Sentry.requestDataIntegration({ include: { data: false, cookies: false, ip: false } }),
    ],

    // Send structured logs to Sentry
    enableLogs: true,
    // Tracing: sample everything locally, a tenth in production.
    tracesSampleRate: isProduction ? 0.1 : 1.0,
    // Set sampling rate for profiling - this is evaluated only once per SDK.init call
    profileSessionSampleRate: isProduction ? 0.1 : 1.0,
    // Trace lifecycle automatically enables profiling during active traces
    profileLifecycle: "trace",

    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
      }
      return event;
    },
  });
}
