export type ExecutableGroup = 'all' | 'fast' | 'plugin' | 'dashboard' | 'integration';

export function makePlan(paths: string[], options?: { full?: boolean; reason?: string }): {
  reason: string;
  executableGroup: ExecutableGroup;
  formalFamilies: string[];
  rustUnitTestsRequired: boolean;
};
export function selectValidation(options?: { base?: string; head?: string; full?: boolean; exactBase?: boolean; cwd?: string }): {
  changedPaths: string[];
  reason: string;
  executableGroup: ExecutableGroup;
  formalFamilies: string[];
  rustUnitTestsRequired: boolean;
};
