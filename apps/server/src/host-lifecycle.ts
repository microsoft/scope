// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// An interrupted launcher must not leave a second host worker consuming the same
// queue. The parent IPC channel is the supervisor liveness signal; when it
// disappears, kill the process group so installed CLI descendants cannot keep
// running after Scope Server has lost ownership of them.
if (process.connected) {
  process.once("disconnect", () => {
    if (process.env.SCOPE_HOST_PROCESS_GROUP === "true" && process.platform !== "win32") {
      process.kill(-process.pid, "SIGKILL");
      return;
    }
    setTimeout(() => process.exit(1), 10_000).unref();
    process.kill(process.pid, "SIGTERM");
  });
  process.channel?.unref();
}
