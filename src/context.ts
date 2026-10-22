import { AsyncLocalStorage } from 'node:async_hooks';

export interface UserContext {
  oid: string;
  roles: string[];
}

export const userContext = new AsyncLocalStorage<UserContext>();
