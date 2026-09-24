export const MAX_ROOT_IGNORE_BYTES: number;

export class RootIgnorePolicyError extends Error {
  readonly code: string;
}

export function createRootIgnorePolicy(bytes: Uint8Array | null | undefined): Readonly<{
  ignores(path: string, isDirectory?: boolean): boolean;
}>;
