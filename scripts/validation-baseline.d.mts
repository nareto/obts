export function needsPluginPublication(candidate: string, latest: string): boolean;
export function normalizeValidationBaseline(options: {
  eventName: string;
  publication?: boolean;
  before?: string;
  pullRequestBase?: string;
  releaseBase?: string;
  head?: string;
  full?: boolean;
}, cwd?: string): {
  base: string;
  full: boolean;
  policyRequired: boolean;
};
