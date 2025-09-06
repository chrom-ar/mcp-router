import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  userId?: string;
  userEmail?: string;
  apiKey?: string;
  requestId?: string;
}

// Create async local storage for request context
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

// Helper to get current request context
export const getRequestContext = (): RequestContext | undefined => {
  return requestContextStorage.getStore();
};

// Helper to run a function with request context
export const runWithContext = <T>(context: RequestContext, fn: () => T | Promise<T>): T | Promise<T> => {
  return requestContextStorage.run(context, fn);
};
