import { appendFileSync } from "node:fs";
const LOG_FILE = "/tmp/unhandled-trace.log";
function log(msg: string): void {
  appendFileSync(LOG_FILE, msg + "\n");
}
log(`[DEBUG] setup LOADED in pid ${process.pid} at ${new Date().toISOString()}`);
process.on("unhandledRejection", (reason: unknown) => {
  log(`[DEBUG] unhandledRejection pid=${process.pid}: ${reason instanceof Error ? reason.message : String(reason)}`);
  if (reason instanceof Error && reason.stack) {
    log(`[DEBUG] stack:\n${reason.stack}`);
  }
});
process.on("uncaughtException", (err: Error) => {
  log(`[DEBUG] uncaughtException pid=${process.pid}: ${err.message}`);
  if (err.stack) log(`[DEBUG] stack:\n${err.stack}`);
});
