export type UnportableReason = 'reserved_characters' | 'case_collision';

export type UnportablePath = {
  path: string;
  kind: 'file' | 'directory';
  reasons: UnportableReason[];
};

export const NAME_RESTRICTION_RULE_VERSION: number;
export const RESTRICTED_NAME_PLATFORMS: readonly string[];
export function isRestrictedNamePlatform(platform: unknown): boolean;
export function segmentHasReservedCharacters(segment: string): boolean;
export function foldPathCase(path: string): string;
export function findUnportablePaths(files: Iterable<string>, directories?: Iterable<string>): UnportablePath[];
