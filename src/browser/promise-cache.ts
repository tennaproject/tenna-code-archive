export class PromiseLruCache<T> {
  private readonly requests = new Map<string, Promise<T>>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Cache limit must be positive");
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    let request = this.requests.get(key);
    if (request === undefined) {
      if (this.requests.size >= this.limit) {
        const oldest = this.requests.keys().next().value;
        if (oldest !== undefined) this.requests.delete(oldest);
      }
      request = load();
      this.requests.set(key, request);
      void request.catch(() => {
        if (this.requests.get(key) === request) this.requests.delete(key);
      });
    } else {
      this.requests.delete(key);
      this.requests.set(key, request);
    }
    return request;
  }
}
