import type { HighlightedDiffRow } from "./diff";
import { diffResponseId, parseDiffWorkerResponse } from "./diff-response";
import type { RenumberTables } from "../shared/renumbering";
import { workerUrl } from "./ui";

const pending = new Map<
  number,
  {
    resolve: (rows: HighlightedDiffRow[]) => void;
    reject: (error: Error) => void;
  }
>();
let requestId = 0;
let workerFailure: Error | undefined;
let worker = createWorker();

function createWorker(): Worker {
  const instance = new Worker(workerUrl("diffWorker"), { type: "module" });
  instance.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (instance !== worker) return;
    const id = diffResponseId(event.data);
    if (id === undefined) {
      rejectPending(new Error("Invalid diff worker response"));
      return;
    }
    const request = pending.get(id);
    if (request === undefined) return;
    pending.delete(id);
    try {
      const response = parseDiffWorkerResponse(event.data);
      if ("error" in response) request.reject(new Error(response.error));
      else request.resolve(response.rows);
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error("Invalid diff worker response"));
    }
  });

  instance.addEventListener("error", (event) => {
    if (instance !== worker) return;
    rejectPending(
      event.error instanceof Error ? event.error : new Error(event.message || "Diff worker failed"),
    );
  });

  instance.addEventListener("messageerror", () => {
    if (instance !== worker) return;
    rejectPending(new Error("Invalid diff worker response"));
  });
  return instance;
}

function rejectPending(error: Error): void {
  workerFailure = error;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

export function cancelDiff(): void {
  if (pending.size === 0 && workerFailure === undefined) return;
  const cancellation = new Error("Diff request was superseded");
  cancellation.name = "AbortError";
  for (const request of pending.values()) request.reject(cancellation);
  pending.clear();
  worker.terminate();
  worker = createWorker();
  workerFailure = undefined;
}

export function calculateDiff(
  before: string[],
  after: string[],
  tables?: RenumberTables,
): Promise<HighlightedDiffRow[]> {
  cancelDiff();
  requestId += 1;
  const id = requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, before, after, tables });
  });
}
