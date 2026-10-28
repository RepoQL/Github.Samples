/**
 * Every credential the pack accepts, by the environment name it is read from. The harness adapters accept these, and
 * redaction scrubs every one of them, so a credential a harness gains cannot leave the runner unscrubbed.
 */

/** Claude Code's keys. CLAUDE_CODE_USE_BEDROCK and _VERTEX are switches, not secrets; the cloud's own keys are. */
export const CLAUDE = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export const CODEX = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;

/** Provider keys opencode reads from the environment; any one lets it reach a model without a person. */
export const OPENCODE = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "FIREWORKS_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MOONSHOT_API_KEY",
] as const;

/** What the reviewer holds besides its agent's key: the job's GitHub token and rql's key. */
export const JOB = ["GH_TOKEN", "GITHUB_TOKEN", "REPOQL_API_KEY"] as const;

export const SECRET_NAMES: readonly string[] = [...new Set<string>([...JOB, ...CLAUDE, ...CODEX, ...OPENCODE])];

/**
 * A backstop for a credential no list names yet: a provider's key, a cloud's secret, the runner's own tokens. A
 * value shorter than eight characters is never scrubbed, so a switch such as `1` is not.
 */
export const SECRET_PATTERN = /(?:API_KEY|_TOKEN|_SECRET|_SECRET_KEY|_ACCESS_KEY|_PASSWORD)$/;

/** The values of every credential in the environment, named or matching the pattern. */
export function credentialValues(environ: NodeJS.ProcessEnv): string[] {
  const names = new Set<string>(SECRET_NAMES);
  for (const name of Object.keys(environ)) if (SECRET_PATTERN.test(name)) names.add(name);
  return [...names].map((name) => environ[name] ?? "");
}
