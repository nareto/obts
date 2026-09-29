export function evaluateGate(input: {
  executableGroup: string;
  formalFamilies?: string[];
  rustUnitTestsRequired?: boolean;
  results: Record<string, string | undefined>;
}): { passed: boolean; reason: string };
