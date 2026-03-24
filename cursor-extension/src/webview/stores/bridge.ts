let vscodeApi: VsCodeApi | undefined;
const pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let requestId = 0;

function ensureApi(): VsCodeApi {
  if (!vscodeApi) {
    vscodeApi = acquireVsCodeApi();
  }
  return vscodeApi;
}

export const bridge = {
  init() {
    ensureApi();
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.responseId == null) return;
      const pending = pendingRequests.get(msg.responseId);
      if (!pending) return;
      pendingRequests.delete(msg.responseId);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.data);
    });
  },

  request(type: string, payload?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      pendingRequests.set(id, { resolve, reject });
      ensureApi().postMessage({ type, id, ...payload });
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error("Request timed out"));
        }
      }, 30000);
    });
  },

  notifyNodeSelected(node: { id: string; layer: string; summary: string; violation_count: number } | null) {
    ensureApi().postMessage({
      type: "nodeSelected",
      node: node ? { id: node.id, layer: node.layer, summary: node.summary || "", violation_count: node.violation_count || 0 } : null,
    });
  },

  openFile(filePath: string) {
    ensureApi().postMessage({ type: "openFile", path: filePath });
  },
};
